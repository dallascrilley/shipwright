import type { PullRequestRef } from "./types.js";

const PULL_REQUEST_PATH = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)$/;

export function parsePullRequestUrl(value: string): PullRequestRef {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("pull request must be a canonical GitHub pull request URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("pull request must be a canonical GitHub pull request URL");
  }
  const match = PULL_REQUEST_PATH.exec(url.pathname.replace(/\/$/, ""));
  if (!match) throw new Error("pull request must be a canonical GitHub pull request URL");
  const [, owner, repo, number] = match;
  return { owner, repo, number: Number(number), url: `https://github.com/${owner}/${repo}/pull/${number}` };
}
