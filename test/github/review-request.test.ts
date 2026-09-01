import { createHmac } from "node:crypto";

import { describe, expect, test } from "bun:test";

import type { ReviewCommandConfig } from "../../src/config/github.js";
import {
  buildReviewRequest,
  parseReviewCommand,
  ReviewRequestConflictError,
  signReviewRequest,
} from "../../src/github/review-request.js";
import type { PullRequestContext } from "../../src/github/types.js";

const config: ReviewCommandConfig = {
  repository: "acme/widget",
  operatorLogin: "operator",
  operatorUserId: 42,
  requestUrl: new URL("http://127.0.0.1:11100/api/v1/review-requests"),
  protocolSecret: "p".repeat(32),
};
const candidatePayload = {
  action: "created",
  repository: { full_name: "Acme/Widget" },
  issue: { number: 7, pull_request: { url: "https://example.invalid" } },
  comment: {
    id: 99,
    body: "  @shipwright review\n",
    user: { id: 42, login: "Operator" },
  },
  sender: { id: 42, login: "Operator" },
};
const pullRequest: PullRequestContext = {
  owner: "Acme",
  repo: "Widget",
  number: 7,
  url: "https://example.invalid/acme/widget/pull/7",
  title: "Canary",
  body: "",
  draft: false,
  baseBranch: "main",
  baseSha: "b".repeat(40),
  headBranch: "factory-ready",
  headSha: "a".repeat(40),
  installationId: 19,
};

describe("parseReviewCommand", () => {
  test("accepts only the exact trimmed operator command on a pull request", () => {
    expect(
      parseReviewCommand(JSON.stringify(candidatePayload), "delivery-1", config),
    ).toEqual({
      kind: "candidate",
      candidate: {
        repository: "acme/widget",
        pullNumber: 7,
        deliveryId: "delivery-1",
        commentId: 99,
        requestedBy: { login: "operator", userId: 42 },
      },
    });
  });

  test.each([
    ["wrong action", { action: "edited" }],
    ["wrong body", { comment: { ...candidatePayload.comment, body: "please review" } }],
    ["wrong repository", { repository: { full_name: "acme/other" } }],
    ["ordinary issue", { issue: { number: 7 } }],
    ["spoofed commenter", { comment: { ...candidatePayload.comment, user: { id: 9, login: "operator" } } }],
    ["spoofed sender", { sender: { id: 9, login: "operator" } }],
    ["wrong sender login", { sender: { id: 42, login: "other" } }],
  ])("ignores %s", (_name, override) => {
    expect(
      parseReviewCommand(
        JSON.stringify({ ...candidatePayload, ...override }),
        "delivery-1",
        config,
      ),
    ).toEqual({ kind: "ignored" });
  });

  test("ignores malformed JSON", () => {
    expect(parseReviewCommand("not-json", "delivery-1", config)).toEqual({
      kind: "ignored",
    });
  });
});

describe("buildReviewRequest", () => {
  const parsed = parseReviewCommand(
    JSON.stringify(candidatePayload),
    "delivery-1",
    config,
  );
  if (parsed.kind !== "candidate") throw new Error("candidate fixture invalid");

  test("builds the exact typed current-head request", () => {
    expect(buildReviewRequest(parsed.candidate, pullRequest, 19)).toEqual({
      schemaVersion: 1,
      repository: "acme/widget",
      pullNumber: 7,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      requestedBy: { login: "operator", userId: 42 },
      source: {
        kind: "issue_comment",
        deliveryId: "delivery-1",
        commentId: 99,
      },
    });
  });

  test.each([
    ["draft", { draft: true }],
    ["wrong installation", { installationId: 20 }],
    ["wrong repository", { repo: "other" }],
    ["wrong pull number", { number: 8 }],
    ["invalid head", { headSha: "moving" }],
    ["invalid base", { baseSha: "moving" }],
  ] satisfies Array<[string, Partial<PullRequestContext>]>) (
    "rejects %s before emission",
    (_name, override) => {
      expect(() =>
        buildReviewRequest(parsed.candidate, { ...pullRequest, ...override }, 19),
      ).toThrow(ReviewRequestConflictError);
    },
  );
});

describe("signReviewRequest", () => {
  test("uses deterministic identity and signs only the typed bytes", () => {
    const request = {
      schemaVersion: 1 as const,
      repository: "acme/widget",
      pullNumber: 7,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      requestedBy: { login: "operator", userId: 42 },
      source: {
        kind: "issue_comment" as const,
        deliveryId: "delivery-1",
        commentId: 99,
      },
    };
    const signed = signReviewRequest(request, config.protocolSecret, "1234");
    const expected = `sha256=${createHmac("sha256", config.protocolSecret)
      .update(`1234\ngithub:delivery-1:comment:99\n${signed.rawBody}`)
      .digest("hex")}`;

    expect(signed).toEqual({
      requestId: "github:delivery-1:comment:99",
      timestamp: "1234",
      signature: expected,
      rawBody: JSON.stringify(request),
    });
    expect(signed.rawBody).not.toContain("@shipwright review");
  });
});
