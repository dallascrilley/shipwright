import { resolveShipwrightStateDirectory } from "../config/state.js";
import { purgeReviewArtifacts } from "../pipeline/repair-candidate.js";
import { redactSecrets } from "../pipeline/receipt.js";

const USAGE =
  "Usage: bun run review-retention -- [--max-age-days <1-3650>] [--dry-run]";

function parseRetentionArgs(argv: string[]): { maxAgeMs: number; dryRun: boolean } {
  let maxAgeDays = 30;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--max-age-days") {
      const value = argv[++index];
      if (!value || !/^\d+$/.test(value)) throw new Error(`invalid max age: ${value ?? "(missing)"}\n${USAGE}`);
      maxAgeDays = Number(value);
      if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 3_650) {
        throw new Error(`invalid max age: ${value}\n${USAGE}`);
      }
      continue;
    }
    throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  return { maxAgeMs: maxAgeDays * 24 * 60 * 60 * 1_000, dryRun };
}

export async function reviewRetentionMain(argv = process.argv.slice(2)): Promise<void> {
  const options = parseRetentionArgs(argv);
  const result = await purgeReviewArtifacts(resolveShipwrightStateDirectory(), options);
  console.log(JSON.stringify(result, null, 2));
}

export async function runReviewRetentionMain(argv = process.argv.slice(2)): Promise<number> {
  try {
    await reviewRetentionMain(argv);
    return 0;
  } catch (error) {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}
