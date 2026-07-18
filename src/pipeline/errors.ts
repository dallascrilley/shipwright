import type { RunPhase } from "./receipt.js";

export class PipelineError extends Error {
  constructor(readonly phase: RunPhase, readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PipelineError";
  }
}
