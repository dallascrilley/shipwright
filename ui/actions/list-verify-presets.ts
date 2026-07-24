import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import {
  listVerifyPresets,
  selectVerifyPreset,
} from "../server/verify-presets";

export default defineAction({
  description:
    "List server-owned Shipwright verification command presets and an optional target-aware recommendation.",
  schema: z
    .object({
      owner: z.string().trim().max(200).optional(),
      repo: z.string().trim().max(200).optional(),
      issueUrl: z.string().trim().max(500).optional(),
      pullRequestUrl: z.string().trim().max(500).optional(),
    })
    .optional()
    .default({}),
  http: { method: "GET" },
  readOnly: true,
  toolCallable: false,
  run: async (input) => {
    const presets = listVerifyPresets();
    let owner = input.owner?.trim() || "";
    let repo = input.repo?.trim() || "";
    const url = (input.issueUrl || input.pullRequestUrl || "").trim();
    if ((!owner || !repo) && url) {
      const match = url.match(
        /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/\d+\/?$/i,
      );
      if (match) {
        owner = match[1] || owner;
        repo = match[2] || repo;
      }
    }
    const recommendation = selectVerifyPreset({
      ...(owner ? { owner } : {}),
      ...(repo ? { repo } : {}),
    });
    return {
      presets,
      recommendation: {
        presetId: recommendation.preset.id,
        command: recommendation.preset.command,
        label: recommendation.preset.label,
        selectionReason: recommendation.selectionReason,
        source: recommendation.source,
      },
    };
  },
});
