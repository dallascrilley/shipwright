import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import {
  readReviewCandidate,
  reviewCandidatePath,
} from "../../src/pipeline/repair-candidate.js";
import { resolveShipwrightStateDirectory } from "../../src/config/state.js";

const candidateIdSchema = z
  .object({
    candidateId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
  })
  .strict();

export default defineAction({
  description:
    "Inspect a retained review candidate without returning its patch bytes.",
  schema: candidateIdSchema,
  http: { method: "GET" },
  readOnly: true,
  toolCallable: false,
  run: async ({ candidateId }) => {
    const candidate = await readReviewCandidate(
      reviewCandidatePath(resolveShipwrightStateDirectory(), candidateId),
    );
    return {
      schema: candidate.schema,
      candidateId: candidate.candidateId,
      candidateDigest: candidate.candidateDigest,
      authorizedBaseRef: candidate.authorizedBaseRef,
      authorizedBaseSha: candidate.authorizedBaseSha,
      authorizedHeadRef: candidate.authorizedHeadRef,
      authorizedHeadSha: candidate.authorizedHeadSha,
      resultingTreeSha: candidate.resultingTreeSha,
      patchBytes: candidate.patchBytes,
      changedFiles: candidate.changedFiles,
      findings: candidate.findings,
      verification: candidate.verification,
      deliveryMode: candidate.deliveryMode,
      verificationRecords: candidate.verificationRecords,
      effects: candidate.effects,
      resumeCursor: candidate.resumeCursor,
      createdAt: candidate.createdAt,
    };
  },
});
