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

  if (comment.responses && comment.responses.length > 0) {
    body += `\n#### 他エキスパートへの見解\n`;
    for (const r of comment.responses) {
      const stanceEmoji = r.stance === "agree" ? "👍" : "👎";
      body += `- **${r.expert}**: ${stanceEmoji} ${r.reason}\n`;
    }
  }

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => T,
  retries = 3,
  delayMs = 1000
): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(delayMs * (i + 1));
    }
  }
  throw new Error("Unreachable");
}

async function createReviewComment(
  context: PRContext,
  thread: ThreadedComment,
  body: string
): Promise<number> {
  const endpoint = `repos/${context.owner}/${context.repo}/pulls/${context.pullNumber}/comments`;
  const payload = JSON.stringify({
    commit_id: context.headSha,
    path: thread.path,
    line: thread.line,
    body,
  });
  const result = await withRetry(() =>
    execSync(`gh api -X POST ${endpoint} --input -`, {
      input: payload,
    }).toString()
  );
  return JSON.parse(result).id;
}

async function createReplyComment(
  context: PRContext,
  commentId: number,
  body: string
): Promise<void> {
  const endpoint = `repos/${context.owner}/${context.repo}/pulls/${context.pullNumber}/comments/${commentId}/replies`;
  const payload = JSON.stringify({ body });
  await withRetry(() =>
    execSync(`gh api -X POST ${endpoint} --input -`, { input: payload })
  );
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
  const firstCommentId = await createReviewComment(
    context,
    thread,
    formatComment(first)
  );

  for (let i = 1; i < thread.thread.length; i++) {
    const comment = thread.thread[i];
    const stance = comment.vote === first.vote ? ": 👍 賛成" : ": 👎 反対";
    await createReplyComment(
      context,
      firstCommentId,
      formatComment(comment, stance)
    );
  }

  await createReplyComment(
    context,
    firstCommentId,
    formatVoteTable(thread.thread, thread.finalVerdict)
  );
}
