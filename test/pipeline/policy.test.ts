import { describe, expect, test } from "bun:test";
import { assertPublishableChange } from "../../src/pipeline/policy.js";

describe("assertPublishableChange", () => {
  test("accepts a small source change", () => {
    expect(() =>
      assertPublishableChange({ changedFiles: ["src/index.ts"], patchBytes: 512 }),
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
});
