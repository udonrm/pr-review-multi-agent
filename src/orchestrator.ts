import { ClaudeClient } from "./claude/client";
import { DiffParser } from "./github/diff-parser";
import { CommentPoster } from "./github/comment-poster";
import {
  getAllAgentTypes,
  getAgentConfig,
  DISCUSSION_PROMPT,
} from "./agents/prompts";
import type {
  PRContext,
  InitialReview,
  DiscussionResult,
  FinalReviewResult,
  ThreadedComment,
  AgentComment,
  Vote,
  CommentLabel,
  CommentDecoration,
} from "./types";

interface ReviewResponse {
  comments: Array<{
    path: string;
    line: number;
    label: CommentLabel;
    decorations: CommentDecoration[];
    subject: string;
    discussion?: string;
  }>;
  summary: string;
  vote: Vote;
  reasoning: string;
}

interface ExpertResponse {
  expert: string;
  stance: "agree" | "disagree";
  reason: string;
}

interface DiscussionResponse {
  responses: ExpertResponse[];
  finalVote: Vote;
  finalReasoning: string;
}

const REVIEW_SCHEMA = {
  type: "object" as const,
  properties: {
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "number" },
          label: {
            type: "string",
            enum: [
              "praise",
              "nitpick",
              "suggestion",
              "issue",
              "todo",
              "question",
              "thought",
              "chore",
            ],
          },
          decorations: {
            type: "array",
            items: {
              type: "string",
              enum: ["blocking", "non-blocking", "if-minor"],
            },
          },
          subject: { type: "string" },
          discussion: { type: "string" },
        },
        required: ["path", "line", "label", "subject"],
      },
    },
    summary: { type: "string" },
    vote: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES"] },
    reasoning: { type: "string" },
  },
  required: ["comments", "summary", "vote", "reasoning"] as string[],
};

const DISCUSSION_SCHEMA = {
  type: "object" as const,
  properties: {
    responses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          expert: { type: "string" },
          stance: { type: "string", enum: ["agree", "disagree"] },
          reason: { type: "string" },
        },
        required: ["expert", "stance", "reason"],
      },
    },
    finalVote: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES"] },
    finalReasoning: { type: "string" },
  },
  required: ["responses", "finalVote", "finalReasoning"] as string[],
};

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

    const discussions = await this.runDiscussionRound(initialReviews);
    const result = this.consolidateResults(initialReviews, discussions);

    await this.poster.postReview(context, result);
    return result;
  }

  private async runInitialReviews(
    context: PRContext,
    diffContent: string
  ): Promise<InitialReview[]> {
    const prompt = `## Pull Request: ${context.title}\n\n${
      context.body || "(No description)"
    }\n\n## Diff\n\n${diffContent}`;

    const reviews: InitialReview[] = [];

    for (const type of getAllAgentTypes()) {
      const config = getAgentConfig(type);
      const res = await this.claude.chatJSON<ReviewResponse>(
        config.systemPrompt,
        prompt,
        REVIEW_SCHEMA
      );
      const comments = Array.isArray(res.comments) ? res.comments : [];

      reviews.push({
        agent: type,
        comments: comments.map((c) => ({
          ...c,
          decorations: Array.isArray(c.decorations) ? c.decorations : [],
        })),
        summary: res.summary || "",
        initialVote: res.vote || "APPROVE",
        reasoning: res.reasoning || "",
      } as InitialReview);
    }

    return reviews;
  }

  private async runDiscussionRound(
    reviews: InitialReview[]
  ): Promise<DiscussionResult[]> {
    const discussions: DiscussionResult[] = [];

    // 直列実行でレートリミットを回避
    for (const review of reviews) {
      const others = reviews.filter((r) => r.agent !== review.agent);
      const prompt = this.buildDiscussionPrompt(others);
      const config = getAgentConfig(review.agent);
      const res = await this.claude.chatJSON<DiscussionResponse>(
        config.systemPrompt,
        prompt,
        DISCUSSION_SCHEMA
      );

      discussions.push({
        agent: review.agent,
        responses: Array.isArray(res.responses) ? res.responses : [],
        finalVote: res.finalVote || "APPROVE",
        finalReasoning: res.finalReasoning || "",
      } as DiscussionResult);
    }

    return discussions;
  }

  private buildDiscussionPrompt(otherReviews: InitialReview[]): string {
    const othersText = otherReviews
      .map((r) => {
        const cfg = getAgentConfig(r.agent);
        const comments = r.comments
          .map((c) => {
            const dec = c.decorations.length
              ? ` (${c.decorations.join(", ")})`
              : "";
            return `- ${c.label}${dec}: ${c.subject} [${c.path}:${c.line}]`;
          })
          .join("\n");
        return `### ${cfg.name}\nVote: ${r.initialVote}\nSummary: ${r.summary}\n${comments}`;
      })
      .join("\n\n");

    return DISCUSSION_PROMPT.replace("{otherReviews}", othersText);
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

    const finalVote: Vote =
      voteCount.requestChanges >= 3 ? "REQUEST_CHANGES" : "APPROVE";

    return {
      initialReviews: reviews,
      discussions,
      finalVote,
      voteCount,
      consolidatedComments: this.buildThreadedComments(reviews),
    };
  }

  private buildThreadedComments(reviews: InitialReview[]): ThreadedComment[] {
    const map = new Map<
      string,
      { path: string; line: number; agentComments: Map<string, AgentComment> }
    >();

    for (const review of reviews) {
      for (const c of review.comments) {
        const key = `${c.path}:${c.line}`;
        const entry = map.get(key) || {
          path: c.path,
          line: c.line,
          agentComments: new Map(),
        };

        const existing = entry.agentComments.get(review.agent);
        if (existing) {
          existing.subject += ` / ${c.label}: ${c.subject}`;
          if (c.discussion) {
            existing.discussion = existing.discussion
              ? `${existing.discussion}\n\n${c.discussion}`
              : c.discussion;
          }
          if (
            c.decorations.includes("blocking") &&
            !existing.decorations.includes("blocking")
          ) {
            existing.decorations.push("blocking");
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

    return Array.from(map.values()).map((item) => {
      const comments = Array.from(item.agentComments.values());
      const requestChangesCount = comments.filter(
        (c) => c.vote === "REQUEST_CHANGES"
      ).length;

      return {
        path: item.path,
        line: item.line,
        thread: comments,
        finalVerdict: requestChangesCount >= 2 ? "REQUEST_CHANGES" : "APPROVE",
      };
    });
  }

  private emptyResult(): FinalReviewResult {
    return {
      initialReviews: [],
      discussions: [],
      finalVote: "APPROVE",
      voteCount: { approve: 5, requestChanges: 0 },
      consolidatedComments: [],
    };
  }
}
