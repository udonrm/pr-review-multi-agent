import { ReviewOrchestrator } from "./review/orchestrator";

const githubToken = process.env.GITHUB_TOKEN!;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY!;
const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");

const eventPath = process.env.GITHUB_EVENT_PATH;
const pullNumber = eventPath
  ? JSON.parse(await Bun.file(eventPath).text()).pull_request?.number
  : Number(process.env.PR_NUMBER);

const orchestrator = new ReviewOrchestrator(githubToken, anthropicApiKey);
await orchestrator.runReview(owner, repo, pullNumber);
