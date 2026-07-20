import { expect, test } from "bun:test";
import {
  containsSecretLikeContent,
  redactSecrets,
  truncateTail,
  VERIFICATION_TAIL_MAX_BYTES,
} from "../../src/pipeline/receipt.js";

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

test("redacts model API key and bearer shapes", () => {
  const samples = [
    "sk-" + "a".repeat(40),
    "sk-ant-" + "b".repeat(40),
    "sk-or-" + "c".repeat(40),
    "Bearer " + "d".repeat(40),
  ];
  for (const sample of samples) {
    const output = redactSecrets(`token=${sample}`);
    expect(output).not.toContain(sample);
    expect(output).toContain("[REDACTED]");
    expect(containsSecretLikeContent(sample)).toBe(true);
  }
});

test("preserves ordinary prose, SHAs, and execution provenance", () => {
  const input = JSON.stringify({
    title: "Fix sk- short note and docs",
    sha: "0123456789abcdef0123456789abcdef01234567",
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
  expect(output).toContain("Fix sk- short note and docs");
  expect(output).toContain("0123456789abcdef0123456789abcdef01234567");
  expect(output).not.toContain("ghs_");
  expect(containsSecretLikeContent("Fix the login flow")).toBe(false);
  expect(containsSecretLikeContent("0123456789abcdef0123456789abcdef01234567")).toBe(false);
});

test("truncateTail keeps the last window within the byte budget", () => {
  const body = "x".repeat(VERIFICATION_TAIL_MAX_BYTES + 50);
  const tail = truncateTail(body);
  expect(new TextEncoder().encode(tail).byteLength).toBeLessThanOrEqual(VERIFICATION_TAIL_MAX_BYTES);
  expect(tail.endsWith("x".repeat(20))).toBe(true);
});
