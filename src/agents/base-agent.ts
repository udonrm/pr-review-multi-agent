import { ClaudeClient } from "../claude/client";
import { getAgentConfig, DISCUSSION_PROMPT } from "./prompts";
import type {
  AgentType,
  PRContext,
  InitialReview,
  DiscussionResult,
  CommentLabel,
  CommentDecoration,
  Vote,
} from "../types";

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

interface DiscussionResponse {
  agreements: string[];
  disagreements: string[];
  finalVote: Vote;
  finalReasoning: string;
}

export class ReviewAgent {
  constructor(private client: ClaudeClient, private type: AgentType) {}

  async performInitialReview(
    context: PRContext,
    diffContent: string
  ): Promise<InitialReview> {
    const config = getAgentConfig(this.type);
    const prompt = `## Pull Request: ${context.title}\n\n${
      context.body || "(説明なし)"
    }\n\n## 差分\n\n${diffContent}`;

    const res = await this.client.chatJSON<ReviewResponse>(
      config.systemPrompt,
      prompt
    );

    return {
      agent: this.type,
      comments: res.comments.map((c) => ({
        ...c,
        decorations: c.decorations || [],
      })),
      summary: res.summary,
      initialVote: res.vote,
      reasoning: res.reasoning,
    };
  }

  async discussAndVote(
    yourReview: InitialReview,
    otherReviews: InitialReview[]
  ): Promise<DiscussionResult> {
    const config = getAgentConfig(this.type);

    const othersText = otherReviews
      .map((r) => {
        const cfg = getAgentConfig(r.agent);
        const comments = r.comments
          .slice(0, 5)
          .map((c) => {
            const dec = c.decorations.length
              ? ` (${c.decorations.join(", ")})`
              : "";
            return `- ${c.label}${dec}: ${c.subject} [${c.path}:${c.line}]`;
          })
          .join("\n");
        return `### ${cfg.name}\n判定: ${r.initialVote}\nサマリー: ${r.summary}\n${comments}`;
      })
      .join("\n\n");

    const yourText = `判定: ${yourReview.initialVote}\nサマリー: ${yourReview.summary}`;
    const prompt = DISCUSSION_PROMPT.replace(
      "{otherReviews}",
      othersText
    ).replace("{yourReview}", yourText);

    const res = await this.client.chatJSON<DiscussionResponse>(
      config.systemPrompt,
      prompt
    );

    return {
      agent: this.type,
      agreements: res.agreements,
      disagreements: res.disagreements,
      finalVote: res.finalVote,
      finalReasoning: res.finalReasoning,
    };
  }
}
