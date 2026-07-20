import { describe, expect, test } from "bun:test";
import { assertPublishableChange } from "../../src/pipeline/policy.js";

describe("assertPublishableChange", () => {
  test("accepts a small source change", () => {
    expect(() =>
      assertPublishableChange({
        changedFiles: ["src/index.ts"],
        patchBytes: 512,
        patch: "diff --git a/src/index.ts b/src/index.ts\n+export const ok = true;\n",
      }),
    ).not.toThrow();
  });

  test("rejects empty, protected, oversized, and excessive changes", () => {
    expect(() => assertPublishableChange({ changedFiles: [], patchBytes: 0 })).toThrow(
      "no changes",
    );
    expect(() =>
      assertPublishableChange({ changedFiles: [".github/workflows/ci.yml"], patchBytes: 1 }),
    ).toThrow("protected path");
    expect(() =>
      assertPublishableChange({ changedFiles: ["src/index.ts"], patchBytes: 1_048_577 }),
    ).toThrow("patch limit");
    expect(() =>
      assertPublishableChange({
        changedFiles: Array.from({ length: 101 }, (_, index) => `src/${index}.ts`),
        patchBytes: 1,
      }),
    ).toThrow("file limit");
  });

  test("rejects patches that embed private keys or high-confidence tokens", () => {
    expect(() =>
      assertPublishableChange({
        changedFiles: ["src/config.ts"],
        patchBytes: 200,
        patch: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
      }),
    ).toThrow("patch appears to contain a secret");
    expect(() =>
      assertPublishableChange({
        changedFiles: ["src/config.ts"],
        patchBytes: 200,
        patch: "const token = \"ghs_123456789012345678901234567890123456\";\n",
      }),
    ).toThrow("patch appears to contain a secret");
    expect(() =>
      assertPublishableChange({
        changedFiles: ["src/config.ts"],
        patchBytes: 200,
        patch: "const key = \"sk-" + "e".repeat(40) + "\";\n",
      }),
    ).toThrow("patch appears to contain a secret");
  });
});
