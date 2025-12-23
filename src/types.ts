export type AgentType =
  | "security-expert"
  | "performance-expert"
  | "readability-expert"
  | "architecture-expert"
  | "testing-expert";

export type Vote = "APPROVE" | "REQUEST_CHANGES";

export type CommentLabel =
  | "praise"
  | "nitpick"
  | "suggestion"
  | "issue"
  | "todo"
  | "question"
  | "thought"
  | "chore";

export type CommentDecoration = "blocking" | "non-blocking" | "if-minor";

export interface FileDiff {
  filename: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  label: CommentLabel;
  decorations: CommentDecoration[];
  subject: string;
  discussion?: string;
}

export interface InitialReview {
  agent: AgentType;
  comments: ReviewComment[];
  summary: string;
  initialVote: Vote;
  reasoning: string;
}

export interface ExpertResponse {
  expert: string;
  stance: "agree" | "disagree";
  reason: string;
}

export interface DiscussionResult {
  agent: AgentType;
  responses: ExpertResponse[];
  finalVote: Vote;
  finalReasoning: string;
}

export interface FinalReviewResult {
  initialReviews: InitialReview[];
  discussions: DiscussionResult[];
  finalVote: Vote;
  voteCount: { approve: number; requestChanges: number };
  consolidatedComments: ThreadedComment[];
}

export interface ThreadedComment {
  path: string;
  line: number;
  thread: AgentComment[];
  finalVerdict: Vote;
}

export interface AgentComment {
  agent: AgentType;
  label: CommentLabel;
  decorations: CommentDecoration[];
  subject: string;
  discussion?: string;
  vote: Vote;
}

export interface PRContext {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  title: string;
  body: string;
  files: FileDiff[];
}

export interface AgentConfig {
  type: AgentType;
  name: string;
  systemPrompt: string;
}
