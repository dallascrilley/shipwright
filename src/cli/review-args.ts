export type ReviewDeliveryMode = "patch" | "commit" | "follow-up-pr" | "evidence-only";

export interface ReviewCliArgs {
  pullRequestUrl: string;
  verifyCommand: string;
  skillPath: string;
  publish: boolean;
  deliveryMode: ReviewDeliveryMode;
  candidateId?: string;
  timeoutMinutes: number;
}

const USAGE =
  "Usage: bun run review-agent -- <pull-request-url> --verify <command> --skill <SKILL.md> [--publish] [--candidate-id <id>] [--delivery-mode patch|commit|follow-up-pr|evidence-only] [--timeout-minutes <1-120>]";

export function parseReviewArgs(argv: string[]): ReviewCliArgs {
  const pullRequestUrl = argv[0];
  if (!pullRequestUrl || pullRequestUrl.startsWith("--")) throw new Error(USAGE);
  let verifyCommand: string | undefined;
  let skillPath: string | undefined;
  let publish = false;
  let deliveryMode: ReviewDeliveryMode = "patch";
  let candidateId: string | undefined;
  let timeoutMinutes = 30;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--publish") publish = true;
    else if (arg === "--delivery-mode") {
      const value = argv[++index];
      if (value !== "patch" && value !== "commit" && value !== "follow-up-pr" && value !== "evidence-only") {
        throw new Error(`invalid delivery mode: ${value ?? "(missing)"}`);
      }
      deliveryMode = value;
    } else if (arg === "--candidate-id") {
      const value = argv[++index]?.trim();
      if (!value || value.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
        throw new Error(`invalid candidate id: ${value ?? "(missing)"}`);
      }
      candidateId = value;
    } else if (arg === "--timeout-minutes") {
      const value = argv[++index];
      if (!value || !/^\d+$/.test(value)) {
        throw new Error(`invalid timeout: ${value ?? "(missing)"}`);
      }
      timeoutMinutes = Number(value);
    } else if (arg === "--verify") verifyCommand = argv[++index];
    else if (arg === "--skill") skillPath = argv[++index];
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  if (!verifyCommand?.trim()) throw new Error(`--verify is required\n${USAGE}`);
  if (!skillPath?.trim()) throw new Error(`--skill is required\n${USAGE}`);
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) {
    throw new Error("timeout must be an integer between 1 and 120 minutes");
  }
  return {
    pullRequestUrl,
    verifyCommand,
    skillPath,
    publish,
    deliveryMode,
    ...(candidateId ? { candidateId } : {}),
    timeoutMinutes,
  };
}
