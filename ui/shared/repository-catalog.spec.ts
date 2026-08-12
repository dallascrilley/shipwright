import { describe, expect, test } from "vitest";

import {
  agentRepositoryCatalogResultSchema,
  buildRepositoryPickerView,
  canSaveRepositorySelection,
  normalizeRepositoryIdentifier,
} from "./repository-catalog";

const repositories = [
  {
    repository: "dallascrilley/shipwright",
    owner: "dallascrilley",
    name: "shipwright",
    defaultBranch: "main",
    visibility: "private" as const,
    archived: false,
    selectable: true,
  },
  {
    repository: "dallascrilleymartech/example-service",
    owner: "dallascrilleymartech",
    name: "example-service",
    defaultBranch: "main",
    visibility: "private" as const,
    archived: false,
    selectable: true,
  },
  {
    repository: "dallascrilley/retired-app",
    owner: "dallascrilley",
    name: "retired-app",
    defaultBranch: "main",
    visibility: "private" as const,
    archived: true,
    selectable: false,
  },
];

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

  test("projects loading, filtered, empty, and error picker states", () => {
    expect(buildRepositoryPickerView(undefined, "", "")).toMatchObject({
      state: "loading",
      options: [],
    });
    expect(
      buildRepositoryPickerView(
        { ok: true, repositories },
        "Example",
        "dallascrilley/shipwright",
      ),
    ).toMatchObject({
      state: "ready",
      options: [{ repository: "dallascrilleymartech/example-service" }],
    });
    expect(
      buildRepositoryPickerView({ ok: true, repositories }, "not-present", ""),
    ).toMatchObject({ state: "empty", options: [] });
    expect(
      buildRepositoryPickerView(
        {
          ok: false,
          code: "github_unavailable",
          message: "Repository catalog is temporarily unavailable.",
        },
        "",
        "dallascrilley/shipwright",
      ),
    ).toMatchObject({
      state: "error",
      options: [
        {
          repository: "dallascrilley/shipwright",
          current: true,
          unavailable: true,
          selectable: false,
        },
      ],
    });
  });

  test("keeps unavailable current repositories visible and marks archived rows", () => {
    const view = buildRepositoryPickerView(
      { ok: true, repositories },
      "",
      "dallascrilleymartech/legacy-agent",
    );

    expect(view.options.map((option) => option.repository)).toEqual([
      "dallascrilley/retired-app",
      "dallascrilley/shipwright",
      "dallascrilleymartech/example-service",
      "dallascrilleymartech/legacy-agent",
    ]);
    expect(view.options[0]).toMatchObject({
      archived: true,
      unavailable: true,
      selectable: false,
    });
    expect(view.options[3]).toMatchObject({
      current: true,
      unavailable: true,
      selectable: false,
    });
  });

  test("allows unchanged saves during outages but blocks unsafe scope changes", () => {
    const failure = {
      ok: false as const,
      code: "github_unavailable" as const,
      message: "Repository catalog is temporarily unavailable.",
    };
    expect(
      canSaveRepositorySelection(
        failure,
        "dallascrilley/shipwright",
        "DallasCrilley/Shipwright",
      ),
    ).toBe(true);
    expect(
      canSaveRepositorySelection(
        failure,
        "dallascrilley/shipwright",
        "dallascrilleymartech/example-service",
      ),
    ).toBe(false);
    expect(
      canSaveRepositorySelection(
        { ok: true, repositories },
        "",
        "dallascrilleymartech/example-service",
      ),
    ).toBe(true);
    expect(
      canSaveRepositorySelection(
        { ok: true, repositories },
        "",
        "dallascrilley/retired-app",
      ),
    ).toBe(false);
  });
});
