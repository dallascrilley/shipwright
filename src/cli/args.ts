export interface CliArgs {
  issueUrl: string;
  verifyCommand: string;
  publish: boolean;
  timeoutMinutes: number;
}

const USAGE =
  "Usage: bun run shipwright -- <issue-url> --verify <command> [--publish] [--timeout-minutes <1-120>]";

export function parseArgs(argv: string[]): CliArgs {
  const issueUrl = argv[0];
  if (!issueUrl || issueUrl.startsWith("--")) throw new Error(USAGE);

  let verifyCommand: string | undefined;
  let publish = false;
  let timeoutMinutes = 30;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--publish") {
      publish = true;
    } else if (arg === "--verify") {
      verifyCommand = argv[++index];
    } else if (arg === "--timeout-minutes") {
      timeoutMinutes = Number(argv[++index]);
    } else {
      throw new Error(`unknown argument: ${arg}\n${USAGE}`);
    }
  }

  if (!verifyCommand?.trim()) throw new Error(`--verify is required\n${USAGE}`);
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) {
    throw new Error("timeout must be an integer between 1 and 120 minutes");
  }
  return { issueUrl, verifyCommand, publish, timeoutMinutes };
}
