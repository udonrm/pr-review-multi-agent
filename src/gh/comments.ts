import { execSync } from "child_process";
import { getAgentConfig } from "../review/agents";
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

function formatComment(comment: AgentComment, prefix = ""): string {
  const label = getLabelWithEmoji(comment.label);
  const dec = comment.decorations.length
    ? ` (${comment.decorations.join(", ")})`
    : "";

  let body = `### ${getAgentLabel(comment.agent)}${prefix}\n\n`;
  body += `**${label}**${dec}: ${comment.subject}\n`;
  if (comment.discussion) body += `\n${comment.discussion}\n`;
  body += `\n**Vote**: ${voteEmoji(comment.vote)} ${comment.vote}`;
  return body;
}

function formatVoteTable(
  comments: { agent: AgentType; vote: Vote }[],
  finalVerdict: Vote
): string {
  const approveCount = comments.filter((c) => c.vote === "APPROVE").length;
  const requestChangesCount = comments.filter(
    (c) => c.vote === "REQUEST_CHANGES"
  ).length;
  const verdict =
    finalVerdict === "APPROVE" ? "✅ Approved" : "🔴 Changes Requested";

  let body = `## 📊 Vote Result: ${verdict}\n\n`;
  body += `| Expert | Decision |\n|--------|------|\n`;
  for (const c of comments) {
    body += `| ${getAgentLabel(c.agent)} | ${voteEmoji(c.vote)} ${c.vote} |\n`;
  }
  body += `\n**Result: ${approveCount} ✅ / ${requestChangesCount} ❌ → ${verdict}**`;
  return body;
}

function createReviewComment(
  context: PRContext,
  thread: ThreadedComment,
  body: string
): number {
  const endpoint = `repos/${context.owner}/${context.repo}/pulls/${context.pullNumber}/comments`;
  const payload = {
    commit_id: context.headSha,
    path: thread.path,
    line: thread.line,
    body,
  };
  const result = execSync(
    `gh api -X POST ${endpoint} -f commit_id="${payload.commit_id}" -f path="${
      payload.path
    }" -F line=${payload.line} -f body=${JSON.stringify(payload.body)}`
  ).toString();
  return JSON.parse(result).id;
}

function createReplyComment(
  context: PRContext,
  commentId: number,
  body: string
): void {
  const endpoint = `repos/${context.owner}/${context.repo}/pulls/${context.pullNumber}/comments/${commentId}/replies`;
  execSync(`gh api -X POST ${endpoint} -f body=${JSON.stringify(body)}`);
}

export async function postReviewComments(
  token: string,
  context: PRContext,
  result: FinalReviewResult
): Promise<void> {
  for (const thread of result.consolidatedComments) {
    await postThread(context, thread);
  }
}

async function postThread(
  context: PRContext,
  thread: ThreadedComment
): Promise<void> {
  if (thread.thread.length === 0) return;

  const first = thread.thread[0];
  const firstCommentId = createReviewComment(
    context,
    thread,
    formatComment(first)
  );

  for (let i = 1; i < thread.thread.length; i++) {
    const comment = thread.thread[i];
    const stance = comment.vote === first.vote ? ": 👍 賛成" : ": 👎 反対";
    createReplyComment(context, firstCommentId, formatComment(comment, stance));
  }

  createReplyComment(
    context,
    firstCommentId,
    formatVoteTable(thread.thread, thread.finalVerdict)
  );
}
