import { parseArgs } from "./args.js";
import { runShipwright } from "../pipeline/run.js";
import { redactSecrets } from "../pipeline/receipt.js";
import { createPipelineDependencies } from "./dependencies.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("run interrupted by signal"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const receipt = await runShipwright(args, createPipelineDependencies({
      signal: controller.signal,
    }));
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

export async function runMain(argv = process.argv.slice(2)): Promise<number> {
  try {
    await main(argv);
    return 0;
  } catch (error) {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}
