import { Octokit } from "@octokit/rest";
import type {
  PRContext,
  FinalReviewResult,
  ThreadedComment,
  AgentType,
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
    await this.octokit.pulls.createReview({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
      commit_id: context.headSha,
      body: this.formatSummary(result),
      event: result.finalVote,
      comments: result.consolidatedComments.map((c) => ({
        path: c.path,
        line: c.line,
        body: this.formatThreadedComment(c),
      })),
    });
  }

  private formatThreadedComment(thread: ThreadedComment): string {
    if (thread.thread.length === 0) return "";

    const first = thread.thread[0];
    const others = thread.thread.slice(1);
    const verdict =
      thread.finalVerdict === "APPROVE" ? "✅ 承認" : "🔴 修正必要";

    // 1人目の発言（起点）
    const firstDec = first.decorations.length
      ? ` (${first.decorations.join(", ")})`
      : "";
    let body = `### ${AGENT_NAMES[first.agent]}の指摘\n\n`;
    body += `**${first.label}**${firstDec}: ${first.subject}\n`;
    if (first.discussion) {
      body += `\n${first.discussion}\n`;
    }

    // 他の専門家の賛否
    if (others.length > 0) {
      body += `\n---\n\n### 他の専門家の意見\n\n`;

      for (const comment of others) {
        const name = AGENT_NAMES[comment.agent];
        const agrees = comment.vote === first.vote;
        const stance = agrees ? "👍 賛成" : "👎 反対";

        body += `**${name}**: ${stance}\n\n`;

        if (comment.subject !== first.subject || comment.discussion) {
          const dec = comment.decorations.length
            ? ` (${comment.decorations.join(", ")})`
            : "";
          body += `> ${comment.label}${dec}: ${comment.subject}\n`;
          if (comment.discussion) {
            body += `> ${comment.discussion.replace(/\n/g, "\n> ")}\n`;
          }
        }
        body += "\n";
      }
    }

    // 結論
    const agreeCount = thread.thread.filter(
      (c) => c.vote === first.vote
    ).length;
    const disagreeCount = thread.thread.length - agreeCount;
    body += `---\n\n**結論**: ${verdict}（賛成 ${agreeCount} / 反対 ${disagreeCount}）`;

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
