import { describe, expect, test } from "bun:test";
import { parseIssueUrl } from "../../src/github/issue-ref.js";

describe("parseIssueUrl", () => {
  test("parses a canonical GitHub issue URL", () => {
    expect(parseIssueUrl("https://github.com/Owner/Repo/issues/42")).toEqual({
      owner: "Owner",
      repo: "Repo",
      number: 42,
      url: "https://github.com/Owner/Repo/issues/42",
    });
  });

  test.each([
    "http://github.com/owner/repo/issues/1",
    "https://example.com/owner/repo/issues/1",
    "https://github.com/owner/repo/pull/1",
    "https://github.com/owner/repo/issues/0",
    "https://github.com/owner/repo/issues/1/comments",
  ])("rejects %s", (url) => {
    expect(() => parseIssueUrl(url)).toThrow("canonical GitHub issue URL");
  });
});
