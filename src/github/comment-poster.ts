import { Octokit } from "@octokit/rest";
import type {
  PRContext,
  FinalReviewResult,
  ThreadedComment,
  AgentType,
  AgentComment,
  CommentLabel,
} from "../types";

const AGENT_INFO: Record<AgentType, { emoji: string; name: string }> = {
  "security-expert": { emoji: "🔒", name: "Security" },
  "performance-expert": { emoji: "⚡", name: "Performance" },
  "readability-expert": { emoji: "📖", name: "Readability" },
  "architecture-expert": { emoji: "🏗️", name: "Architecture" },
  "testing-expert": { emoji: "🧪", name: "Testing" },
};

const getAgentLabel = (agent: AgentType): string => {
  const info = AGENT_INFO[agent];
  return `${info.emoji} ${info.name}`;
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

const getLabelWithEmoji = (label: CommentLabel): string => {
  return `${LABEL_EMOJI[label]} ${label}`;
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
    // まずサマリーのみでレビューを作成
    // GitHub Actions は APPROVE を許可しないため COMMENT を使用
    await this.octokit.pulls.createReview({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
      commit_id: context.headSha,
      body: this.formatSummary(result),
      event: "COMMENT",
    });

    // 各スレッドをReply形式で投稿
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

    // 1人目のコメントを投稿
    const { data: firstComment } = await this.octokit.pulls.createReviewComment(
      {
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullNumber,
        commit_id: context.headSha,
        path: thread.path,
        line: thread.line,
        body: this.formatFirstComment(first),
      }
    );

    // 2人目以降をReplyとして投稿
    for (let i = 1; i < thread.thread.length; i++) {
      const comment = thread.thread[i];
      const stance = comment.vote === first.vote ? "👍 賛成" : "👎 反対";

      await this.octokit.pulls.createReplyForReviewComment({
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullNumber,
        comment_id: firstComment.id,
        body: this.formatReplyComment(comment, stance),
      });
    }

    // 最後に結論をReplyとして投稿
    const approveCount = thread.thread.filter(
      (c) => c.vote === "APPROVE"
    ).length;
    const requestChangesCount = thread.thread.length - approveCount;
    const verdict =
      thread.finalVerdict === "APPROVE"
        ? "✅ Approved"
        : "🔴 Changes Requested";
    const resultText =
      thread.finalVerdict === "APPROVE" ? "Approved" : "Changes requested";

    let body = `## 📊 Vote Result: ${verdict}\n\n`;
    body += `| Expert | Decision |\n|--------|------|\n`;
    for (const c of thread.thread) {
      const voteEmoji = c.vote === "APPROVE" ? "✅" : "❌";
      body += `| ${getAgentLabel(c.agent)} | ${voteEmoji} ${c.vote} |\n`;
    }
    body += `\n**Result: ${approveCount} ✅ / ${requestChangesCount} ❌ → ${resultText}**`;

    await this.octokit.pulls.createReplyForReviewComment({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
      comment_id: firstComment.id,
      body,
    });
  }

  private formatFirstComment(comment: AgentComment): string {
    const agentLabel = getAgentLabel(comment.agent);
    const labelWithEmoji = getLabelWithEmoji(comment.label);
    const dec = comment.decorations.length
      ? ` (${comment.decorations.join(", ")})`
      : "";
    const voteEmoji = comment.vote === "APPROVE" ? "✅" : "❌";

    let body = `### ${agentLabel}\n\n`;
    body += `**${labelWithEmoji}**${dec}: ${comment.subject}\n`;
    if (comment.discussion) {
      body += `\n${comment.discussion}\n`;
    }
    body += `\n**Vote**: ${voteEmoji} ${comment.vote}`;
    return body;
  }

  private formatReplyComment(comment: AgentComment, stance: string): string {
    const agentLabel = getAgentLabel(comment.agent);
    const labelWithEmoji = getLabelWithEmoji(comment.label);
    const dec = comment.decorations.length
      ? ` (${comment.decorations.join(", ")})`
      : "";
    const voteEmoji = comment.vote === "APPROVE" ? "✅" : "❌";

    let body = `### ${agentLabel}: ${stance}\n\n`;
    if (comment.subject) {
      body += `**${labelWithEmoji}**${dec}: ${comment.subject}\n`;
    }
    if (comment.discussion) {
      body += `\n${comment.discussion}\n`;
    }
    body += `\n**Vote**: ${voteEmoji} ${comment.vote}`;
    return body;
  }

  private formatSummary(result: FinalReviewResult): string {
    const { approve, requestChanges } = result.voteCount;
    const verdict =
      result.finalVote === "APPROVE" ? "✅ Approved" : "🔴 Changes Requested";
    const resultText =
      result.finalVote === "APPROVE" ? "Approved" : "Changes requested";

    let s = `## 📊 Multi-Agent Review Result: ${verdict}\n\n`;
    s += `| Expert | Decision |\n|--------|------|\n`;

    for (const r of result.initialReviews) {
      const voteEmoji = r.initialVote === "APPROVE" ? "✅" : "❌";
      s += `| ${getAgentLabel(r.agent)} | ${voteEmoji} ${r.initialVote} |\n`;
    }

    s += `\n**Result: ${approve} ✅ / ${requestChanges} ❌ → ${resultText}**\n\n`;
    s += `---\n\n### Expert Opinions\n\n`;

    for (const r of result.initialReviews) {
      const counts = this.countLabels(r.comments);
      s += `#### ${getAgentLabel(r.agent)}\n${
        r.summary
      }\n- Comments: ${counts}\n\n`;
    }

    return s + `---\n${result.summary}`;
  }

  private countLabels(comments: Array<{ label: CommentLabel }>): string {
    const counts: Partial<Record<CommentLabel, number>> = {};
    for (const c of comments) counts[c.label] = (counts[c.label] || 0) + 1;
    return (
      Object.entries(counts)
        .map(([k, v]) => `${LABEL_EMOJI[k as CommentLabel]} ${k}: ${v}`)
        .join(", ") || "none"
    );
  }
}
