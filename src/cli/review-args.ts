export interface ReviewCliArgs {
  pullRequestUrl: string;
  verifyCommand: string;
  skillPath: string;
  publish: boolean;
  timeoutMinutes: number;
}

const USAGE =
  "Usage: bun run review-agent -- <pull-request-url> --verify <command> --skill <SKILL.md> [--publish] [--timeout-minutes <1-120>]";

export function parseReviewArgs(argv: string[]): ReviewCliArgs {
  const pullRequestUrl = argv[0];
  if (!pullRequestUrl || pullRequestUrl.startsWith("--")) throw new Error(USAGE);
  let verifyCommand: string | undefined;
  let skillPath: string | undefined;
  let publish = false;
  let timeoutMinutes = 30;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--publish") publish = true;
    else if (arg === "--verify") verifyCommand = argv[++index];
    else if (arg === "--skill") skillPath = argv[++index];
    else if (arg === "--timeout-minutes") timeoutMinutes = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  if (!verifyCommand?.trim()) throw new Error(`--verify is required\n${USAGE}`);
  if (!skillPath?.trim()) throw new Error(`--skill is required\n${USAGE}`);
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) {
    throw new Error("timeout must be an integer between 1 and 120 minutes");
  }
  return { pullRequestUrl, verifyCommand, skillPath, publish, timeoutMinutes };
}
