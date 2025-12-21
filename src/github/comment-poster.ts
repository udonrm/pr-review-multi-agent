import { Octokit } from "@octokit/rest";
import type {
  PRContext,
  FinalReviewResult,
  ThreadedComment,
  AgentType,
  AgentComment,
  CommentLabel,
} from "../types";

const AGENT_NAMES: Record<AgentType, string> = {
  "security-expert": "セキュリティ専門家",
  "performance-expert": "パフォーマンス専門家",
  "readability-expert": "可読性専門家",
  "architecture-expert": "アーキテクチャ専門家",
  "testing-expert": "テスト専門家",
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
    await this.octokit.pulls.createReview({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
      commit_id: context.headSha,
      body: this.formatSummary(result),
      event: result.finalVote,
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
      thread.finalVerdict === "APPROVE" ? "✅ 承認" : "🔴 修正必要";

    await this.octokit.pulls.createReplyForReviewComment({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
      comment_id: firstComment.id,
      body: `**結論**: ${verdict}\n\n| 投票 | 票数 |\n|------|------|\n| APPROVE | ${approveCount} |\n| REQUEST_CHANGES | ${requestChangesCount} |`,
    });
  }

  private formatFirstComment(comment: AgentComment): string {
    const name = AGENT_NAMES[comment.agent];
    const dec = comment.decorations.length
      ? ` (${comment.decorations.join(", ")})`
      : "";

    let body = `### ${name}\n\n`;
    body += `**${comment.label}**${dec}: ${comment.subject}\n`;
    if (comment.discussion) {
      body += `\n${comment.discussion}\n`;
    }
    body += `\n**判定**: ${comment.vote}`;
    return body;
  }

  private formatReplyComment(comment: AgentComment, stance: string): string {
    const name = AGENT_NAMES[comment.agent];
    const dec = comment.decorations.length
      ? ` (${comment.decorations.join(", ")})`
      : "";

    let body = `### ${name}: ${stance}\n\n`;
    if (comment.subject) {
      body += `**${comment.label}**${dec}: ${comment.subject}\n`;
    }
    if (comment.discussion) {
      body += `\n${comment.discussion}\n`;
    }
    body += `\n**判定**: ${comment.vote}`;
    return body;
  }

  private formatSummary(result: FinalReviewResult): string {
    const emoji = result.finalVote === "APPROVE" ? "✅" : "🔴";
    const { approve, requestChanges } = result.voteCount;

    let s = `## ${emoji} マルチエージェントレビュー結果\n\n`;
    s += `| 判定 | 票数 |\n|------|------|\n| APPROVE | ${approve} |\n| REQUEST_CHANGES | ${requestChanges} |\n\n`;
    s += `**最終判定: ${result.finalVote}**\n\n### 各専門家の見解\n\n`;

    for (const r of result.initialReviews) {
      const counts = this.countLabels(r.comments);
      s += `#### ${AGENT_NAMES[r.agent]}\n- ${r.initialVote}: ${
        r.summary
      }\n- 指摘: ${counts}\n\n`;
    }

    if (result.discussions.length > 0) {
      s += `### 議論\n\n`;
      for (const d of result.discussions) {
        if (d.agreements.length)
          s += `**${AGENT_NAMES[d.agent]}が同意:** ${d.agreements.join(
            ", "
          )}\n`;
        if (d.disagreements.length)
          s += `**${AGENT_NAMES[d.agent]}が異論:** ${d.disagreements.join(
            ", "
          )}\n`;
        s += `→ ${d.finalVote}: ${d.finalReasoning}\n\n`;
      }
    }

    return s + `---\n${result.summary}`;
  }

  private countLabels(comments: Array<{ label: CommentLabel }>): string {
    const counts: Partial<Record<CommentLabel, number>> = {};
    for (const c of comments) counts[c.label] = (counts[c.label] || 0) + 1;
    return (
      Object.entries(counts)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ") || "なし"
    );
  }
}
