import { expect, test } from "bun:test";
import { parsePullRequestUrl } from "../../src/github/pull-request-ref.js";

test("parses a canonical GitHub pull request URL", () => {
  expect(parsePullRequestUrl("https://github.com/Owner/Repo/pull/42")).toEqual({
    owner: "Owner",
    repo: "Repo",
    number: 42,
    url: "https://github.com/Owner/Repo/pull/42",
  });
});

test.each([
  "http://github.com/owner/repo/pull/1",
  "https://example.com/owner/repo/pull/1",
  "https://github.com/owner/repo/pulls/1",
  "https://github.com/owner/repo/pull/0",
  "https://github.com/owner/repo/pull/1/files",
  "not-a-url",
])("rejects non-canonical pull request URL %s", (value) => {
  expect(() => parsePullRequestUrl(value)).toThrow("canonical GitHub pull request URL");
});
