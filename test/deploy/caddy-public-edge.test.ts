import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");
const caddyfile = readFileSync(resolve(repoRoot, "deploy", "Caddyfile"), "utf8");

describe("Shipwright public edge", () => {
  test("proxies only POST /api/github/webhook and rejects every other request", () => {
    const directives = caddyfile
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    expect(directives).toEqual([
      "%%PUBLIC_HOST%% {",
      "@webhook {",
      "method POST",
      "path /api/github/webhook",
      "}",
      "handle @webhook {",
      "reverse_proxy 127.0.0.1:4317",
      "}",
      "handle {",
      "respond 404",
      "}",
      "}",
    ]);
  });
});
