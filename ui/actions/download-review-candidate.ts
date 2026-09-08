import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { resolveShipwrightStateDirectory } from "../../src/config/state.js";
import {
  readReviewCandidate,
  reviewCandidatePath,
  reviewCandidatePatch,
} from "../../src/pipeline/repair-candidate.js";

const candidateIdSchema = z
  .object({
    candidateId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
  })
  .strict();

export default defineAction({
  description: "Download the secret-scanned patch for a retained review candidate.",
  schema: candidateIdSchema,
  http: { method: "GET" },
  readOnly: true,
  toolCallable: false,
  run: async ({ candidateId }) => {
    const candidate = await readReviewCandidate(
      reviewCandidatePath(resolveShipwrightStateDirectory(), candidateId),
    );
    const patch = reviewCandidatePatch(candidate);
    return {
      candidateId: candidate.candidateId,
      candidateDigest: candidate.candidateDigest,
      filename: `${candidate.candidateId}.patch`,
      contentType: "text/x-patch",
      patchBase64: Buffer.from(patch).toString("base64"),
      patchBytes: patch.byteLength,
    };
  },
});
