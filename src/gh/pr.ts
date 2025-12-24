import { execSync } from "child_process";
import type { FileDiff, PRContext, PastComment } from "../types";

const IGNORE_PATTERNS = [
  /^\.github\//,
  /^\.vscode\//,
  /^\.idea\//,
  /package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|bun\.lockb$/,
  /\.min\.(js|css)$/,
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|mp4|webm|mp3|pdf)$/i,
  /^(dist|build|out|\.next|node_modules)\//,
  /\.generated\.(ts|js|tsx|jsx)$/,
  /\.d\.ts$/,
  /__snapshots__\//,
  /\.snap$/,
  /\.map$/,
];

interface GitHubFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export async function getPRContext(
  owner: string,
  repo: string,
  pullNumber: number
): Promise<PRContext> {
  const prJson = execSync(
    `gh pr view ${pullNumber} --repo ${owner}/${repo} --json title,body,headRefOid,baseRefOid`
  ).toString();
  const pr = JSON.parse(prJson);

  const filesJson = execSync(
    `gh api repos/${owner}/${repo}/pulls/${pullNumber}/files`
  ).toString();
  const files: GitHubFile[] = JSON.parse(filesJson);

  const fileDiffs: FileDiff[] = files
    .filter((f) => !IGNORE_PATTERNS.some((p) => p.test(f.filename)))
    .map((f) => ({
      filename: f.filename,
      status: f.status as FileDiff["status"],
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch || "",
    }));

  return {
    owner,
    repo,
    pullNumber,
    headSha: pr.headRefOid,
    baseSha: pr.baseRefOid,
    title: pr.title,
    body: pr.body || "",
    files: fileDiffs,
    pastComments: getPastComments(owner, repo, pullNumber),
  };
}

function getPastComments(
  owner: string,
  repo: string,
  pullNumber: number
): PastComment[] {
  try {
    const commentsJson = execSync(
      `gh api repos/${owner}/${repo}/pulls/${pullNumber}/comments`
    ).toString();
    const comments = JSON.parse(commentsJson);

    return comments
      .filter(
        (c: { user: { login: string }; body: string }) =>
          c.user.login === "github-actions[bot]" &&
          !c.body.startsWith("## 📊 Vote Result")
      )
      .map((c: { path: string; line: number; body: string }) => ({
        path: c.path,
        line: c.line,
        body: c.body,
      }));
  } catch {
    return [];
  }
}

export function formatDiff(files: FileDiff[]): string {
  return files
    .map(
      (f) =>
        `## ${f.filename} (${f.status})\n+${f.additions} -${f.deletions}\n\`\`\`diff\n${f.patch}\n\`\`\``
    )
    .join("\n\n");
}
