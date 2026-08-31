import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

describe("webhook replay fixtures", () => {
  test.each([
    ["issues-opened-minimal.json", 147693967],
    ["pull-request-opened-minimal.json", 150175411],
  ])("%s carries the event family's installation", (name, installationId) => {
    const rawBody = readFileSync(
      resolve("test", "fixtures", "github-webhook", name),
      "utf8",
    );
    const payload = JSON.parse(rawBody) as {
      action?: unknown;
      installation?: { id?: unknown };
      repository?: { full_name?: unknown };
    };
    expect(payload.action).toBe("opened");
    expect(payload.installation?.id).toBe(installationId);
    expect(payload.repository?.full_name).toBe("dallascrilley/shipwright");
  });
});
