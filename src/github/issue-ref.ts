import type { IssueRef } from "./types.js";

const ISSUE_PATH = /^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)$/;

export function parseIssueUrl(input: string): IssueRef {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("issue must be a canonical GitHub issue URL");
  }

  const match = ISSUE_PATH.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !match
  ) {
    throw new Error("issue must be a canonical GitHub issue URL");
  }

  const [, owner, repo, number] = match;
  return { owner, repo, number: Number(number), url: url.toString().replace(/\/$/, "") };
}
