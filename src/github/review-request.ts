import { createHmac } from "node:crypto";

import type { ReviewCommandConfig } from "../config/github.js";
import type { PullRequestContext } from "./types.js";

const REVIEW_COMMAND = "@shipwright review";
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface ReviewCommandCandidate {
  repository: string;
  pullNumber: number;
  deliveryId: string;
  commentId: number;
  requestedBy: {
    login: string;
    userId: number;
  };
}

export interface ReviewRequestV1 {
  schemaVersion: 1;
  repository: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  requestedBy: {
    login: string;
    userId: number;
  };
  source: {
    kind: "issue_comment";
    deliveryId: string;
    commentId: number;
  };
}

export type ReviewCommandParseResult =
  | { kind: "ignored" }
  | { kind: "candidate"; candidate: ReviewCommandCandidate };

export interface SignedReviewRequest {
  requestId: string;
  timestamp: string;
  signature: string;
  rawBody: string;
}

export class ReviewRequestConflictError extends Error {}

export function parseReviewCommand(
  rawBody: string,
  deliveryId: string,
  config: ReviewCommandConfig,
): ReviewCommandParseResult {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return { kind: "ignored" };
  }
  if (!isRecord(value) || value.action !== "created") {
    return { kind: "ignored" };
  }
  const repository = value.repository;
  const issue = value.issue;
  const comment = value.comment;
  const sender = value.sender;
  if (
    !isRecord(repository) ||
    canonicalString(repository.full_name) !== config.repository ||
    !isRecord(issue) ||
    !isRecord(issue.pull_request) ||
    !isPositiveInteger(issue.number) ||
    !isRecord(comment) ||
    !isPositiveInteger(comment.id) ||
    typeof comment.body !== "string" ||
    comment.body.trim() !== REVIEW_COMMAND ||
    !isRecord(comment.user) ||
    !isRecord(sender) ||
    comment.user.id !== config.operatorUserId ||
    sender.id !== config.operatorUserId ||
    canonicalString(comment.user.login) !== config.operatorLogin ||
    canonicalString(sender.login) !== config.operatorLogin
  ) {
    return { kind: "ignored" };
  }
  return {
    kind: "candidate",
    candidate: {
      repository: config.repository,
      pullNumber: issue.number,
      deliveryId,
      commentId: comment.id,
      requestedBy: {
        login: config.operatorLogin,
        userId: config.operatorUserId,
      },
    },
  };
}

export function buildReviewRequest(
  candidate: ReviewCommandCandidate,
  pullRequest: PullRequestContext,
  expectedInstallationId: number,
): ReviewRequestV1 {
  const repository = `${pullRequest.owner}/${pullRequest.repo}`.toLowerCase();
  if (
    repository !== candidate.repository ||
    pullRequest.number !== candidate.pullNumber ||
    pullRequest.installationId !== expectedInstallationId ||
    pullRequest.draft
  ) {
    throw new ReviewRequestConflictError(
      "pull request command authorization no longer matches",
    );
  }
  const headSha = canonicalSha(pullRequest.headSha, "head");
  const baseSha = canonicalSha(pullRequest.baseSha, "base");
  return {
    schemaVersion: 1,
    repository,
    pullNumber: candidate.pullNumber,
    headSha,
    baseSha,
    requestedBy: candidate.requestedBy,
    source: {
      kind: "issue_comment",
      deliveryId: candidate.deliveryId,
      commentId: candidate.commentId,
    },
  };
}

export function signReviewRequest(
  request: ReviewRequestV1,
  protocolSecret: string,
  timestamp: string,
): SignedReviewRequest {
  const rawBody = JSON.stringify(request);
  const requestId = `github:${request.source.deliveryId}:comment:${request.source.commentId}`;
  const signature = `sha256=${createHmac("sha256", protocolSecret)
    .update(`${timestamp}\n${requestId}\n${rawBody}`)
    .digest("hex")}`;
  return { requestId, timestamp, signature, rawBody };
}

function canonicalSha(value: string, label: string): string {
  const canonical = value.toLowerCase();
  if (!SHA_PATTERN.test(canonical)) {
    throw new ReviewRequestConflictError(
      `${label} SHA must be exactly 40 hexadecimal characters`,
    );
  }
  return canonical;
}

function canonicalString(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
