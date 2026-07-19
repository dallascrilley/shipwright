import { expect, test } from "bun:test";
import { redactSecrets } from "../../src/pipeline/receipt.js";

test("redacts GitHub tokens, JWTs, PEM blocks, and credential URLs", () => {
  const input = [
    "ghs_123456789012345678901234567890123456",
    "github_pat_123456789012345678901234567890123456",
    "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjMifQ.signature",
    "-----BEGIN PRIVATE KEY----- secret -----END PRIVATE KEY-----",
    "https://x-access-token:secret@github.com/owner/repo.git",
  ].join("\n");

  const output = redactSecrets(input);
  expect(output).not.toContain("secret");
  expect(output).not.toContain("ghs_");
  expect(output).not.toContain("eyJhbGci");
  expect(output).toContain("[REDACTED]");
});

test("preserves non-secret execution provenance while redacting credentials", () => {
  const input = JSON.stringify({
    execution: {
      runtime: "agentos",
      software: "pi",
      provider: "kimi",
      model: "kimi-for-coding",
    },
    credential: "ghs_123456789012345678901234567890123456",
  });

  const output = redactSecrets(input);
  expect(output).toContain('"provider":"kimi"');
  expect(output).toContain('"model":"kimi-for-coding"');
  expect(output).not.toContain("ghs_");
});
