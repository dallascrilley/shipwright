import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveShipwrightStateDirectory } from "../../src/config/state.js";

describe("resolveShipwrightStateDirectory", () => {
  test("uses one repository-root default for root and UI entrypoints", () => {
    const repositoryRoot = resolve("/tmp/shipwright-repository");

    expect(resolveShipwrightStateDirectory(repositoryRoot, undefined)).toBe(
      resolve(repositoryRoot, ".artifacts/shipwright"),
    );
    expect(resolveShipwrightStateDirectory(resolve(repositoryRoot, "ui"), undefined)).toBe(
      resolve(repositoryRoot, ".artifacts/shipwright"),
    );
  });

  test("normalizes an explicit state directory", () => {
    expect(resolveShipwrightStateDirectory("/tmp/shipwright-repository/ui", "../state")).toBe(
      resolve("/tmp/state"),
    );
  });
});
