import { ClaudeClient } from "../llm/claude";
import { getPRContext, formatDiff } from "../gh/pr";
import { postReviewComments } from "../gh/comments";
import { ALL_AGENT_TYPES, getAgentConfig, DISCUSSION_PROMPT } from "./agents";
import { REVIEW_SCHEMA, DISCUSSION_SCHEMA } from "./schemas";
import type {
  PRContext,
  InitialReview,
  DiscussionResult,
  FinalReviewResult,
  ThreadedComment,
  AgentComment,
  AgentType,
  Vote,
  ExpertResponse,
  ReviewComment,
} from "../types";

interface ReviewResponse {
  comments: ReviewComment[];
  summary: string;
  vote: Vote;
  reasoning: string;
}

interface DiscussionResponse {
  responses: ExpertResponse[];
  finalVote: Vote;
  finalReasoning: string;
}

export class ReviewOrchestrator {
  private claude: ClaudeClient;
  private githubToken: string;

  constructor(githubToken: string, anthropicApiKey: string) {
    this.claude = new ClaudeClient(anthropicApiKey);
    this.githubToken = githubToken;
  }

  async runReview(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<FinalReviewResult> {
    const context = await getPRContext(owner, repo, pullNumber);
    if (context.files.length === 0) return this.emptyResult();

    const diffContent = formatDiff(context.files);
    const initialReviews = await this.runInitialReviews(context, diffContent);
    const discussions = await this.runDiscussionRound(initialReviews);
    const result = this.consolidateResults(initialReviews, discussions);

    await postReviewComments(this.githubToken, context, result);
    return result;
  }

  private async runInitialReviews(
    context: PRContext,
    diffContent: string
  ): Promise<InitialReview[]> {
    const pastCommentsText =
      context.pastComments.length > 0
        ? `\n\n## Past Review Comments\n\n${context.pastComments
            .map((c) => `[${c.path}:${c.line}] ${c.body}`)
            .join(
              "\n\n"
            )}\n\nNote: Consider past comments and avoid repeating the same issues if already addressed. Feel free to build upon, agree, or disagree with previous points to continue the discussion.`
        : "";

    const prompt = `## Pull Request: ${context.title}\n\n${
      context.body || "(No description)"
    }\n\n## Diff\n\n${diffContent}${pastCommentsText}`;

    const reviews: InitialReview[] = [];

    for (const type of ALL_AGENT_TYPES) {
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
      });
    }

    return reviews;
  }

  private async runDiscussionRound(
    reviews: InitialReview[]
  ): Promise<DiscussionResult[]> {
    const discussions: DiscussionResult[] = [];

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
      });
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
      consolidatedComments: this.buildThreadedComments(reviews, discussions),
    };
  }

  private buildThreadedComments(
    reviews: InitialReview[],
    discussions: DiscussionResult[]
  ): ThreadedComment[] {
    const discussionMap = new Map<AgentType, DiscussionResult>();
    for (const d of discussions) {
      discussionMap.set(d.agent, d);
    }

    const map = new Map<
      string,
      { path: string; line: number; agentComments: Map<string, AgentComment> }
    >();

    for (const review of reviews) {
      const discussion = discussionMap.get(review.agent);

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
            vote: discussion?.finalVote || review.initialVote,
            responses: discussion?.responses,
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
