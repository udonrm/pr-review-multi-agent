import { Octokit } from "@octokit/rest";
import type { FileDiff, PRContext } from "../types";

export class DiffParser {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async getPRContext(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<PRContext> {
    const [{ data: pr }, { data: files }] = await Promise.all([
      this.octokit.pulls.get({ owner, repo, pull_number: pullNumber }),
      this.octokit.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      }),
    ]);

    const ignorePatterns = [
      // CI/CD, 設定ファイル
      /^\.github\//,
      /^\.vscode\//,
      /^\.idea\//,
      // ロックファイル
      /package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|bun\.lockb$/,
      // ミニファイされたファイル
      /\.min\.(js|css)$/,
      // バイナリ/アセット
      /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|mp4|webm|mp3|pdf)$/i,
      // ビルド成果物
      /^(dist|build|out|\.next|node_modules)\//,
      // 生成ファイル
      /\.generated\.(ts|js|tsx|jsx)$/,
      /\.d\.ts$/,
      // スナップショット
      /__snapshots__\//,
      /\.snap$/,
      // ソースマップ
      /\.map$/,
    ];

    const fileDiffs: FileDiff[] = files
      .filter((f) => !ignorePatterns.some((p) => p.test(f.filename)))
      .map((f) => ({
        filename: f.filename,
        status:
          f.status === "added"
            ? "added"
            : f.status === "removed"
            ? "deleted"
            : f.status === "renamed"
            ? "renamed"
            : "modified",
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch || "",
      }));

    return {
      owner,
      repo,
      pullNumber,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      title: pr.title,
      body: pr.body || "",
      files: fileDiffs,
    };
  }

  formatDiffForReview(files: FileDiff[]): string {
    return files
      .map(
        (f) =>
          `## ${f.filename} (${f.status})\n+${f.additions} -${f.deletions}\n\`\`\`diff\n${f.patch}\n\`\`\``
      )
      .join("\n\n");
  }
}
