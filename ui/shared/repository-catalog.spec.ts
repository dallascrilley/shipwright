import { describe, expect, test } from "vitest";

import {
  agentRepositoryCatalogResultSchema,
  normalizeRepositoryIdentifier,
} from "./repository-catalog";

describe("repository catalog contracts", () => {
  test("normalizes canonical owner/repository identifiers", () => {
    expect(normalizeRepositoryIdentifier(" DallasCrilley/Shipwright ")).toBe(
      "dallascrilley/shipwright",
    );
    expect(normalizeRepositoryIdentifier("shipwright")).toBeUndefined();
    expect(normalizeRepositoryIdentifier("owner/repo/extra")).toBeUndefined();
  });

  test("rejects inconsistent repository availability rows", () => {
    expect(
      agentRepositoryCatalogResultSchema.safeParse({
        ok: true,
        repositories: [
          {
            repository: "DallasCrilley/Shipwright",
            owner: "dallascrilley",
            name: "shipwright",
            defaultBranch: "main",
            visibility: "private",
            archived: "false",
            selectable: true,
          },
        ],
      }).success,
    ).toBe(false);
  });
});
