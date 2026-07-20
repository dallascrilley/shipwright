import { expect, test } from "bun:test";
import { main } from "../src/cli/main.js";
import { parseIssueUrl } from "../src/github/issue-ref.js";

const issueUrl = process.env.SHIPWRIGHT_TEST_ISSUE_URL;
const liveTest = issueUrl && process.env.SHIPWRIGHT_LIVE_PUBLISH === "1" ? test : test.skip;

liveTest("publishes a verified PR for an explicitly configured disposable issue", async () => {
  const issue = parseIssueUrl(issueUrl!);
  expect(["dallascrilley", "dallascrilleymartech"]).toContain(issue.owner.toLowerCase());
  const verifyCommand = process.env.SHIPWRIGHT_TEST_VERIFY;
  if (!verifyCommand) throw new Error("SHIPWRIGHT_TEST_VERIFY is required for the live test");

  await main([issueUrl!, "--verify", verifyCommand, "--publish"]);
}, 2 * 60 * 60_000);
