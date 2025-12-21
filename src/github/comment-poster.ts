import { Octokit } from "@octokit/rest";
import { getAgentConfig } from "../agents/prompts";
import type {
  PRContext,
  FinalReviewResult,
  ThreadedComment,
  AgentComment,
  AgentType,
  CommentLabel,
  Vote,
} from "../types";

const AGENT_EMOJI: Record<AgentType, string> = {
  "security-expert": "🔒",
  "performance-expert": "⚡",
  "readability-expert": "📖",
  "architecture-expert": "🏗️",
  "testing-expert": "🧪",
};

const LABEL_EMOJI: Record<CommentLabel, string> = {
  praise: "👏",
  nitpick: "🔍",
  suggestion: "💡",
  issue: "⚠️",
  todo: "📝",
  question: "❓",
  thought: "💭",
  chore: "🧹",
};

const voteEmoji = (vote: Vote) => (vote === "APPROVE" ? "✅" : "❌");
const getAgentLabel = (type: AgentType) =>
  `${AGENT_EMOJI[type]} ${getAgentConfig(type).name}`;
const getLabelWithEmoji = (label: CommentLabel) =>
  `${LABEL_EMOJI[label]} ${label}`;

const formatComment = (comment: AgentComment, prefix = ""): string => {
  const label = getLabelWithEmoji(comment.label);
  const dec = comment.decorations.length
    ? ` (${comment.decorations.join(", ")})`
    : "";

  let body = `### ${getAgentLabel(comment.agent)}${prefix}\n\n`;
  body += `**${label}**${dec}: ${comment.subject}\n`;
  if (comment.discussion) body += `\n${comment.discussion}\n`;
  body += `\n**Vote**: ${voteEmoji(comment.vote)} ${comment.vote}`;
  return body;
};

const formatVoteTable = (
  comments: { agent: AgentType; vote: Vote }[],
  finalVerdict: Vote
): string => {
  const approveCount = comments.filter((c) => c.vote === "APPROVE").length;
  const requestChangesCount = comments.length - approveCount;
  const verdict =
    finalVerdict === "APPROVE" ? "✅ Approved" : "🔴 Changes Requested";
  const resultText =
    finalVerdict === "APPROVE" ? "Approved" : "Changes requested";

  let body = `## 📊 Vote Result: ${verdict}\n\n`;
  body += `| Expert | Decision |\n|--------|------|\n`;
  for (const c of comments) {
    body += `| ${getAgentLabel(c.agent)} | ${voteEmoji(c.vote)} ${c.vote} |\n`;
  }
  body += `\n**Result: ${approveCount} ✅ / ${requestChangesCount} ❌ → ${resultText}**`;
  return body;
};

export class CommentPoster {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async postReview(
    context: PRContext,
    result: FinalReviewResult
  ): Promise<void> {
    for (const thread of result.consolidatedComments) {
      await this.postThreadAsReplies(context, thread);
    }
  }

  private async postThreadAsReplies(
    context: PRContext,
    thread: ThreadedComment
  ): Promise<void> {
    if (thread.thread.length === 0) return;

    const first = thread.thread[0];
    const { data: firstComment } = await this.octokit.pulls.createReviewComment(
      {
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullNumber,
        commit_id: context.headSha,
        path: thread.path,
        line: thread.line,
        body: formatComment(first),
      }
    );

    for (let i = 1; i < thread.thread.length; i++) {
      const comment = thread.thread[i];
      const stance = comment.vote === first.vote ? ": 👍 賛成" : ": 👎 反対";
      await this.octokit.pulls.createReplyForReviewComment({
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullNumber,
        comment_id: firstComment.id,
        body: formatComment(comment, stance),
      });
    }

    await this.octokit.pulls.createReplyForReviewComment({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
      comment_id: firstComment.id,
      body: formatVoteTable(thread.thread, thread.finalVerdict),
    });
  }
}
