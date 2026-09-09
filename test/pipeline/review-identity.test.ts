import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SandboxWorkspace } from "../../src/sandbox/runtime.js";
import { runReviewAgent, type ReviewWorkspacePort } from "../../src/pipeline/review-run.js";
import { computeReviewChecksDigest, FileReviewEffectJournalStore, FileReviewFindingVerificationStore } from "../../src/pipeline/repair-candidate.js";
import type { AuthorizedPullRequest } from "../../src/github/app-client.js";

const exec = promisify(execFile);

for (const attack of ["branch", "head"] as const) {
  test(`original review delivery rejects agent ${attack} movement before commit or push`, async () => {
    const root = await mkdtemp(join(tmpdir(), "shipwright-identity-"));
    const directory = join(root, "repo");
    const remote = join(root, "remote.git");
    const git = async (...args: string[]) => (await exec("git", args, {
      cwd: directory,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    })).stdout.trim();
    try {
      await mkdir(directory);
      await git("init", "-q", "-b", "feature");
      await writeFile(join(directory, "content.txt"), "baseline\n");
      await git("add", "content.txt");
      await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
      const head = await git("rev-parse", "HEAD");
      await git("init", "--bare", "-q", remote);
      await git("remote", "add", "origin", remote);
      await git("push", "-q", "origin", "feature");
      const actual: SandboxWorkspace = Object.assign(Object.create(SandboxWorkspace.prototype), {
        hostWorkspace: directory, sandboxStopped: true,
      });
      await actual.captureAuthorizedRepoConfig();
      let commits = 0;
      let pushes = 0;
      const thread = { id: "thread-1", isResolved: false, isOutdated: false, path: "content.txt", line: 1,
        comments: [{ id: "comment-1", body: "Repair content", url: "https://example.invalid/comment", author: "reviewer" }] };
      const pr = { title: "Change", body: "", state: "open", draft: false, baseBranch: "main", baseSha: head,
        headBranch: "feature", headSha: head, headOwner: "acme", headRepo: "widget" };
      const unused = async (): Promise<never> => { throw new Error("unexpected remote effect"); };
      const remoteHead = async () => (await git("ls-remote", "origin", "refs/heads/feature")).split(/\s/)[0]!;
      const authorized: AuthorizedPullRequest = {
        pullRequest: { ...pr, owner: "acme", repo: "widget", number: 4, url: "https://github.com/acme/widget/pull/4", installationId: 1 },
        reviewThreads: [thread], reviews: [],
        repositoryClient: {
          getRepository: unused, getIssue: unused, getBranchSha: remoteHead,
          listPullRequests: async () => [], createPullRequest: unused,
          getPullRequest: async () => ({ ...pr, headSha: await remoteHead() }),
          listReviewThreads: async () => [thread], listReviews: async () => [],
          replyToReviewThread: unused, resolveReviewThread: unused, addPullRequestComment: unused,
        },
        withInstallationToken: async (action) => action("fixture"),
      };
      const workspace: ReviewWorkspacePort = {
        clonePullRequest: async () => {}, prepareForAgent: async () => {}, prepareReviewArtifact: async () => {},
        readAndRemoveArtifact: async () => JSON.stringify({ threads: [{ threadId: thread.id, outcome: "fixed", summary: "Repaired", evidence: "content.txt:1" }] }),
        verify: async () => ({ exitCode: 0 }), quiesce: async () => {}, destroy: async () => {},
        inspectChanges: (sha) => actual.inspectChanges(sha),
        assertRunIdentity: (sha, branch) => actual.assertRunIdentity(sha, branch),
        assertCommitIncluded: async () => {},
        commit: async (message) => { commits++; return actual.commit(message); },
        push: async (branch) => { pushes++; await git("push", "origin", branch); },
      };
      const failure = await runReviewAgent({ pullRequestUrl: authorized.pullRequest.url,
        verifyCommand: "fixture-check", publish: true, deliveryMode: "commit",
        ownership: {
          mode: "explicit-handoff", ownerId: "shipwright", fromOwnerId: "acme",
          handoffId: "handoff-1", authorizedBy: "operator", source: "operator",
        },
        timeoutMinutes: 1 }, {
        execution: { runtime: "agentos", software: "pi", provider: "kimi", model: "fixture" },
        skill: { name: "fix-review-findings", content: "fixture", sha256: "abc123" },
        candidateRoot: join(root, "candidates"), authorize: async () => authorized,
        createWorkspace: async () => workspace, writeReceipt: async () => {},
        verificationStore: await FileReviewFindingVerificationStore.open(join(root, "verification")),
        effectJournalFactory: (candidate) => FileReviewEffectJournalStore.open(join(root, "effects.json"), candidate),
        findingVerifier: { verify: async ({ candidate, findingId, checks }) => ({
          schema: "shipwright-review-verification/v1", recordId: "record-1", candidateDigest: candidate.candidateDigest,
          findingId, findingDigest: candidate.findings[0]!.originalContentDigest!, checksDigest: computeReviewChecksDigest(checks),
          observedOutcome: "fixed", observedEvidence: "content.txt:1", observedReproduction: "fixture reproduction",
          observedAffectedFiles: ["content.txt"], requiredChecks: checks.requiredChecks,
          riskLevel: "standard", independentVerdict: "pass", createdAt: new Date().toISOString(),
        }) },
        runAgent: async () => {
          await writeFile(join(directory, "unreviewed.txt"), "unreviewed payload\n");
          await git("add", "unreviewed.txt");
          await git("-c", "user.name=Agent", "-c", "user.email=agent@example.invalid", "commit", "-qm", "unreviewed payload");
          if (attack === "branch") await git("switch", "-c", "alternate", head);
          else await git("rm", "unreviewed.txt");
          await writeFile(join(directory, "content.txt"), "repaired\n");
          return "done";
        },
      }).then(() => "unexpected success", (error: unknown) => error instanceof Error ? error.message : String(error));
      expect({ error: failure, commits, pushes, remoteHead: await remoteHead() }).toEqual({
        error: expect.stringContaining("repository identity changed after authorization"), commits: 0, pushes: 0, remoteHead: head,
      });
      const journal: { effects: Array<{ kind: string }> } = JSON.parse(await readFile(join(root, "effects.json"), "utf8"));
      expect(journal.effects.filter((effect) => effect.kind === "commit")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("host Git proves retained candidates on squash and later owner heads", async () => {
  const root = await mkdtemp(join(tmpdir(), "shipwright-candidate-integration-"));
  const directory = join(root, "repo");
  const patchPath = join(root, "candidate.diff");
  const git = async (...args: string[]) => (await exec("git", args, {
    cwd: directory,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  })).stdout.trim();
  try {
    await mkdir(directory);
    await git("init", "-q", "-b", "feature");
    await writeFile(join(directory, "content.txt"), "baseline\n");
    await git("add", "content.txt");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
    const baseSha = await git("rev-parse", "HEAD");
    const actual: SandboxWorkspace = Object.assign(Object.create(SandboxWorkspace.prototype), {
      hostWorkspace: directory,
      sandboxStopped: true,
    });
    await actual.captureAuthorizedRepoConfig();

    await writeFile(join(directory, "content.txt"), "repaired\n");
    const candidate = await actual.inspectChanges(baseSha);
    const candidateTreeSha = candidate.resultingTreeSha!;
    const patch = candidate.patchData!;
    await actual.commit("candidate");

    await git("reset", "--hard", baseSha);
    await writeFile(patchPath, patch);
    await git("apply", "--binary", patchPath);
    await git("add", "content.txt");
    await git("-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "commit", "-qm", "squash integration");
    const squashHeadSha = await git("rev-parse", "HEAD");
    await actual.assertReviewCandidateIntegrated({
      headSha: squashHeadSha,
      candidateTreeSha,
      patch,
    });

    await writeFile(join(directory, "owner-change.txt"), "additional owner change\n");
    await git("add", "owner-change.txt");
    await git("-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "commit", "-qm", "owner follow-up");
    const extendedHeadSha = await git("rev-parse", "HEAD");
    await actual.assertReviewCandidateIntegrated({
      headSha: extendedHeadSha,
      candidateTreeSha,
      patch,
    });

    await git("reset", "--hard", baseSha);
    await expect(actual.assertReviewCandidateIntegrated({
      headSha: baseSha,
      candidateTreeSha,
      patch,
    })).rejects.toThrow("original PR head does not contain the delivered review candidate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
