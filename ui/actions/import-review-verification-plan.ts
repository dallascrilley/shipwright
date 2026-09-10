import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { resolveShipwrightStateDirectory } from "../../src/config/state.js";
import {
  assertReviewVerificationPlan,
  FileReviewVerificationPlanStore,
  type ReviewVerificationPlan,
} from "../../src/pipeline/repair-candidate.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const identifierSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);

const followUpSchema = z
  .object({
    repository: z.string().trim().min(1).max(200),
    remoteId: z.string().trim().min(1).max(200),
    remoteUrl: z.string().url().max(2_000),
    kind: z.enum(["issue", "pr"]),
    idempotencyKey: z.string().trim().min(1).max(300),
    assignedTo: z.string().trim().min(1).max(200),
    status: z.enum(["assigned", "confirmed", "disputed"]),
  })
  .strict();

const verificationPlanSchema = z
  .object({
    schema: z.literal("shipwright-review-verification-plan/v1"),
    planId: identifierSchema,
    candidateDigest: digestSchema,
    findingId: z.string().trim().min(1).max(300),
    findingDigest: digestSchema,
    command: z.string().trim().min(1).max(4_000),
    timeoutMs: z.number().int().min(1).max(10 * 60 * 1000),
    reproduction: z.object({
      kind: z.literal("behavioral"),
      assertion: z.string().trim().min(1).max(4_000),
    }).strict(),
    baseline: z
      .object({
        expectedExitCode: z.number().int(),
        resultDigest: digestSchema,
      })
      .strict(),
    candidate: z
      .object({
        expectedExitCode: z.number().int(),
        resultDigest: digestSchema,
      })
      .strict(),
    adjudicatedOutcome: z.enum([
      "fixed",
      "deferred",
      "rejected",
      "already-addressed",
      "needs-human",
    ]),
    riskLevel: z.enum(["standard", "high"]),
    independentReview: z
      .object({
        reviewerId: z.string().trim().min(1).max(300),
        contextDigest: digestSchema,
        verdict: z.enum(["pass", "fail", "disputed"]),
        freshContext: z.boolean(),
      })
      .strict(),
    followUp: followUpSchema.optional(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.adjudicatedOutcome === "fixed") {
      if (value.baseline.expectedExitCode === 0 || value.candidate.expectedExitCode !== 0) {
        context.addIssue({
          code: "custom",
          path: ["candidate"],
          message: "Fixed plans require a failing baseline and passing candidate.",
        });
      }
    } else if (
      value.adjudicatedOutcome === "rejected" ||
      value.adjudicatedOutcome === "already-addressed" ||
      value.adjudicatedOutcome === "needs-human"
    ) {
      if (value.baseline.expectedExitCode !== 0 || value.candidate.expectedExitCode !== 0) {
        context.addIssue({
          code: "custom",
          path: ["baseline"],
          message: "No-code plans require both baseline and candidate to pass.",
        });
      }
    }
    if (value.adjudicatedOutcome === "deferred") {
      if (!value.followUp || value.followUp.status !== "confirmed") {
        context.addIssue({
          code: "custom",
          path: ["followUp"],
          message: "Deferred plans require a confirmed host follow-up.",
        });
      }
    } else if (value.followUp !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["followUp"],
        message: "Follow-ups are only valid for deferred plans.",
      });
    }
  });

export default defineAction({
  description:
    "Import an operator-owned review verification plan that binds an exact finding to host checks and an independent reviewer verdict.",
  schema: z.object({ plan: verificationPlanSchema }).strict(),
  needsApproval: () => true,
  agentTool: false,
  toolCallable: false,
  run: async ({ plan }) => {
    const hostPlan = plan as ReviewVerificationPlan;
    assertReviewVerificationPlan(hostPlan);
    await new FileReviewVerificationPlanStore(
      resolveShipwrightStateDirectory(),
    ).put(hostPlan);
    return {
      imported: true,
      planId: hostPlan.planId,
      candidateDigest: hostPlan.candidateDigest,
      findingId: hostPlan.findingId,
      findingDigest: hostPlan.findingDigest,
      riskLevel: hostPlan.riskLevel,
      adjudicatedOutcome: hostPlan.adjudicatedOutcome,
      independentVerdict: hostPlan.independentReview.verdict,
      freshContext: hostPlan.independentReview.freshContext,
    };
  },
});
