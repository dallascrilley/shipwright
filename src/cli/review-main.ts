import { createReviewPipelineDependencies } from "./dependencies.js";
import { parseReviewArgs } from "./review-args.js";
import { runReviewAgent } from "../pipeline/review-run.js";
import { redactSecrets } from "../pipeline/receipt.js";

export async function reviewMain(argv = process.argv.slice(2)): Promise<void> {
  const args = parseReviewArgs(argv);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("run interrupted by signal"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const receipt = await runReviewAgent(args, createReviewPipelineDependencies(args.skillPath, {
      signal: controller.signal,
    }));
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

export async function runReviewMain(argv = process.argv.slice(2)): Promise<number> {
  try {
    await reviewMain(argv);
    return 0;
  } catch (error) {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}
