export const REVIEW_SCHEMA = {
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

export const DISCUSSION_SCHEMA = {
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
