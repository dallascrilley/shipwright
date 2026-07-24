import { afterEach, describe, expect, test } from "vitest";

import {
  assertSafeVerifyCommand,
  DEFAULT_VERIFY_PRESET_ID,
  listVerifyPresets,
  resetVerifyPresetCache,
  resolveStartVerifySelection,
  resolveVerifyPreset,
  selectVerifyPreset,
  validateVerifyPresetsAtStartup,
  VERIFY_PRESETS_ENV,
} from "./verify-presets";

afterEach(() => {
  resetVerifyPresetCache();
  delete process.env[VERIFY_PRESETS_ENV];
});

describe("listVerifyPresets / resolveVerifyPreset", () => {
  test("returns builtin presets by default", () => {
    const presets = listVerifyPresets({});
    expect(presets.map((preset) => preset.id)).toEqual([
      "bun-test",
      "bun-test-typecheck",
    ]);
    expect(resolveVerifyPreset("bun-test", {}).command).toBe("bun test");
  });

  test("rejects malformed configuration without falling back", () => {
    expect(() =>
      listVerifyPresets({ [VERIFY_PRESETS_ENV]: "{not-json" }),
    ).toThrow(/valid JSON/);
    expect(() =>
      listVerifyPresets({ [VERIFY_PRESETS_ENV]: '{"id":"x"}' }),
    ).toThrow(/JSON array/);
    expect(() =>
      listVerifyPresets({
        [VERIFY_PRESETS_ENV]: JSON.stringify([
          { id: "bad", label: "Bad", command: "echo $(whoami)" },
        ]),
      }),
    ).toThrow(/disallowed shell expansion/);
  });

  test("merges valid host configuration over builtins", () => {
    const env = {
      [VERIFY_PRESETS_ENV]: JSON.stringify([
        {
          id: "pytest",
          label: "pytest",
          command: "pytest -q",
          repositories: ["acme/widgets"],
          repositoryGlobs: ["acme/*"],
        },
      ]),
    };
    const presets = listVerifyPresets(env);
    expect(presets.some((preset) => preset.id === "pytest")).toBe(true);
    expect(resolveVerifyPreset("pytest", env).repositories).toEqual([
      "acme/widgets",
    ]);
  });
});

describe("selectVerifyPreset", () => {
  const env = {
    [VERIFY_PRESETS_ENV]: JSON.stringify([
      {
        id: "exact-preset",
        label: "exact",
        command: "bun test exact",
        repositories: ["Acme/Widgets"],
      },
      {
        id: "glob-preset",
        label: "glob",
        command: "bun test glob",
        repositoryGlobs: ["acme/*"],
      },
    ]),
  };

  test("prefers exact match over glob over default", () => {
    expect(
      selectVerifyPreset({ owner: "acme", repo: "widgets" }, env),
    ).toMatchObject({
      source: "exact_repo",
      preset: { id: "exact-preset", command: "bun test exact" },
    });
    expect(
      selectVerifyPreset({ owner: "acme", repo: "other" }, env),
    ).toMatchObject({
      source: "repo_glob",
      preset: { id: "glob-preset", command: "bun test glob" },
    });
    expect(
      selectVerifyPreset({ owner: "other", repo: "repo" }, env),
    ).toMatchObject({
      source: "default",
      preset: { id: DEFAULT_VERIFY_PRESET_ID },
    });
  });

  test("explicit operator choice always wins", () => {
    expect(
      selectVerifyPreset(
        {
          owner: "acme",
          repo: "widgets",
          requestedPresetId: "bun-test-typecheck",
        },
        env,
      ),
    ).toMatchObject({
      source: "explicit",
      preset: { id: "bun-test-typecheck" },
    });
  });
});

describe("resolveStartVerifySelection", () => {
  const env = {
    [VERIFY_PRESETS_ENV]: JSON.stringify([
      {
        id: "exact-preset",
        label: "exact",
        command: "bun test exact",
        repositories: ["acme/widgets"],
      },
    ]),
  };

  test("applies target-aware default when no preset or raw command is provided", () => {
    expect(
      resolveStartVerifySelection({
        owner: "acme",
        repo: "widgets",
        env,
      }),
    ).toMatchObject({
      source: "exact_repo",
      presetId: "exact-preset",
      verifyCommand: "bun test exact",
    });
  });

  test("keeps Advanced raw command path unchanged", () => {
    expect(
      resolveStartVerifySelection({
        owner: "acme",
        repo: "widgets",
        requestedPresetId: "",
        useRawCommand: true,
        rawVerifyCommand: "pnpm test",
        env,
      }),
    ).toMatchObject({
      source: "raw_command",
      presetId: "",
      verifyCommand: "pnpm test",
      selectionReason: "Operator-provided raw verification command",
    });
  });

  test("honors explicit preset over target recommendation", () => {
    expect(
      resolveStartVerifySelection({
        owner: "acme",
        repo: "widgets",
        requestedPresetId: "bun-test",
        env,
      }),
    ).toMatchObject({
      source: "explicit",
      presetId: "bun-test",
      verifyCommand: "bun test",
    });
  });
});

describe("assertSafeVerifyCommand", () => {
  test("rejects empty and expansion-prone commands", () => {
    expect(() => assertSafeVerifyCommand("")).toThrow(/required/);
    expect(() => assertSafeVerifyCommand("echo `id`")).toThrow(/disallowed/);
  });
});

describe("validateVerifyPresetsAtStartup", () => {
  test("no-ops when overlay env is blank", () => {
    expect(() => validateVerifyPresetsAtStartup({})).not.toThrow();
    expect(() =>
      validateVerifyPresetsAtStartup({ [VERIFY_PRESETS_ENV]: "   " }),
    ).not.toThrow();
  });

  test("fails closed on malformed overlay without waiting for first request", () => {
    expect(() =>
      validateVerifyPresetsAtStartup({ [VERIFY_PRESETS_ENV]: "{not-json" }),
    ).toThrow(/valid JSON/);
    expect(() =>
      validateVerifyPresetsAtStartup({
        [VERIFY_PRESETS_ENV]: JSON.stringify([
          { id: "bad", label: "Bad", command: "echo $(whoami)" },
        ]),
      }),
    ).toThrow(/disallowed shell expansion/);
  });

  test("accepts valid overlay configuration", () => {
    expect(() =>
      validateVerifyPresetsAtStartup({
        [VERIFY_PRESETS_ENV]: JSON.stringify([
          {
            id: "pytest",
            label: "pytest",
            command: "pytest -q",
            repositories: ["acme/widgets"],
          },
        ]),
      }),
    ).not.toThrow();
  });
});
