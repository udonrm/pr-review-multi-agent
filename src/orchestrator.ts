import { ClaudeClient } from "./claude/client";
import { DiffParser } from "./github/diff-parser";
import { CommentPoster } from "./github/comment-poster";
import { ReviewAgent } from "./agents/base-agent";
import { getAllAgentTypes } from "./agents/prompts";
import type {
  PRContext,
  InitialReview,
  DiscussionResult,
  FinalReviewResult,
  ThreadedComment,
  AgentComment,
  Vote,
  CommentLabel,
} from "./types";

export class ReviewOrchestrator {
  private claude: ClaudeClient;
  private diff: DiffParser;
  private poster: CommentPoster;

  constructor(githubToken: string, anthropicApiKey: string) {
    this.claude = new ClaudeClient(anthropicApiKey);
    this.diff = new DiffParser(githubToken);
    this.poster = new CommentPoster(githubToken);
  }

  async runReview(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<FinalReviewResult> {
    const context = await this.diff.getPRContext(owner, repo, pullNumber);
    if (context.files.length === 0) return this.emptyResult();

    const diffContent = this.diff.formatDiffForReview(context.files);
    const initialReviews = await this.runInitialReviews(context, diffContent);

    if (initialReviews.every((r) => r.initialVote === "APPROVE")) {
      return this.resultFromInitialReviews(initialReviews);
    }

    const discussions = await this.runDiscussionRound(initialReviews);
    const result = this.consolidateResults(initialReviews, discussions);

    await this.poster.postReview(context, result);
    return result;
  }

  private async runInitialReviews(
    context: PRContext,
    diffContent: string
  ): Promise<InitialReview[]> {
    return Promise.all(
      getAllAgentTypes().map((type) =>
        new ReviewAgent(this.claude, type).performInitialReview(
          context,
          diffContent
        )
      )
    );
  }

  private async runDiscussionRound(
    reviews: InitialReview[]
  ): Promise<DiscussionResult[]> {
    return Promise.all(
      reviews.map((review) => {
        const others = reviews.filter((r) => r.agent !== review.agent);
        return new ReviewAgent(this.claude, review.agent).discussAndVote(
          review,
          others
        );
      })
    );
  }

  private consolidateResults(
    reviews: InitialReview[],
    discussions: DiscussionResult[]
  ): FinalReviewResult {
    const voteCount = { approve: 0, requestChanges: 0 };
    for (const d of discussions) {
      if (d.finalVote === "APPROVE") voteCount.approve++;
      else voteCount.requestChanges++;
    }

    // 多数決（5人中3人以上）
    const finalVote: Vote =
      voteCount.requestChanges >= 3 ? "REQUEST_CHANGES" : "APPROVE";

    return {
      initialReviews: reviews,
      discussions,
      finalVote,
      voteCount,
      consolidatedComments: this.buildThreadedComments(reviews, discussions),
      summary: this.generateSummary(reviews, finalVote),
    };
  }

  private buildThreadedComments(
    reviews: InitialReview[],
    discussions: DiscussionResult[]
  ): ThreadedComment[] {
    // ファイル+行でグループ化
    const map = new Map<
      string,
      { path: string; line: number; agentComments: Map<string, AgentComment> }
    >();

    // Round 1のコメントを追加（1エージェント1コメントにまとめる）
    for (const review of reviews) {
      for (const c of review.comments) {
        const key = `${c.path}:${c.line}`;
        const entry = map.get(key) || {
          path: c.path,
          line: c.line,
          agentComments: new Map(),
        };

        const existingComment = entry.agentComments.get(review.agent);
        if (existingComment) {
          // 同じエージェントの複数コメントをまとめる
          existingComment.subject += ` / ${c.label}: ${c.subject}`;
          if (c.discussion) {
            existingComment.discussion = existingComment.discussion
              ? `${existingComment.discussion}\n\n${c.discussion}`
              : c.discussion;
          }
          // blockingがあれば保持
          if (
            c.decorations.includes("blocking") &&
            !existingComment.decorations.includes("blocking")
          ) {
            existingComment.decorations.push("blocking");
          }
        } else {
          entry.agentComments.set(review.agent, {
            agent: review.agent,
            label: c.label,
            decorations: [...c.decorations],
            subject: c.subject,
            discussion: c.discussion,
            vote: review.initialVote,
          });
        }
        map.set(key, entry);
      }
    }

    // 各スレッドの結論を決定（blockingがあればREQUEST_CHANGES）
    return Array.from(map.values()).map((item) => {
      const comments = Array.from(item.agentComments.values());
      const hasBlocking = comments.some((c) =>
        c.decorations.includes("blocking")
      );
      const requestChangesCount = comments.filter(
        (c) => c.vote === "REQUEST_CHANGES"
      ).length;

      return {
        path: item.path,
        line: item.line,
        thread: comments,
        finalVerdict:
          hasBlocking || requestChangesCount >= 2
            ? "REQUEST_CHANGES"
            : "APPROVE",
      };
    });
  }

  private generateSummary(reviews: InitialReview[], finalVote: Vote): string {
    const total = reviews.reduce((sum, r) => sum + r.comments.length, 0);
    const labels: Record<CommentLabel, number> = {
      praise: 0,
      nitpick: 0,
      suggestion: 0,
      issue: 0,
      todo: 0,
      question: 0,
      thought: 0,
      chore: 0,
    };
    let blocking = 0;

    for (const r of reviews) {
      for (const c of r.comments) {
        labels[c.label]++;
        if (c.decorations.includes("blocking")) blocking++;
      }
    }

    const verdict = finalVote === "APPROVE" ? "承認" : "修正が必要";
    const breakdown = Object.entries(labels)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");

    return `5人の専門家による議論の結果、${verdict}と判断されました。\n\n合計${total}件の指摘。${
      breakdown ? `\n内訳: ${breakdown}` : ""
    }${blocking ? `\n\n**${blocking}件のblocking issue**があります。` : ""}`;
  }

  private emptyResult(): FinalReviewResult {
    return {
      initialReviews: [],
      discussions: [],
      finalVote: "APPROVE",
      voteCount: { approve: 5, requestChanges: 0 },
      consolidatedComments: [],
      summary: "レビュー対象のファイルがありませんでした。",
    };
  }

  private resultFromInitialReviews(
    reviews: InitialReview[]
  ): FinalReviewResult {
    return {
      initialReviews: reviews,
      discussions: [],
      finalVote: "APPROVE",
      voteCount: { approve: 5, requestChanges: 0 },
      consolidatedComments: this.buildThreadedComments(reviews, []),
      summary: "全専門家が承認しました。",
    };
  }
}
