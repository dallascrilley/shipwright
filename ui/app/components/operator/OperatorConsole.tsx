import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import {
  IconAlertTriangle,
  IconCheck,
  IconCircle,
  IconExternalLink,
  IconGitPullRequest,
  IconLoader2,
  IconPlayerPlay,
  IconTerminal2,
} from "@tabler/icons-react";
import { useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import {
  isTerminalRun,
  operatorRunRequestSchema,
  phaseIndex,
  RUN_PHASES,
  type OperatorRunRecord,
  type OperatorRunRequest,
} from "../../../shared/operator-run";

const PHASE_LABELS = {
  intake: "Intake",
  workspace: "Workspace",
  agent: "Agent",
  verify: "Verify",
  policy: "Policy",
  publish: "Publish",
  complete: "Complete",
} as const;

const DEFAULT_ISSUE_URL = "";
const DEFAULT_VERIFY_COMMAND = "bun test";

export function OperatorConsole() {
  const [issueUrl, setIssueUrl] = useState(DEFAULT_ISSUE_URL);
  const [verifyCommand, setVerifyCommand] = useState(DEFAULT_VERIFY_COMMAND);
  const [timeoutMinutes, setTimeoutMinutes] = useState(20);
  const [publish, setPublish] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const startRun = useActionMutation("start-programming-run");
  const runQuery = useActionQuery(
    "get-programming-run",
    runId ? { runId } : {},
    {
      refetchInterval: (query) => {
        const record = query.state.data as OperatorRunRecord | undefined;
        return record && isTerminalRun(record.status) ? false : 500;
      },
    },
  );
  const record = runQuery.data as OperatorRunRecord | undefined;
  const active = Boolean(record && !isTerminalRun(record.status));
  const busy = startRun.isPending || active;

  const candidate = useMemo(
    () => ({
      issueUrl,
      verifyCommand,
      timeoutMinutes,
      publish,
      publishConfirmed: false,
    }),
    [issueUrl, publish, timeoutMinutes, verifyCommand],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const validation = operatorRunRequestSchema.safeParse({
      ...candidate,
      publishConfirmed: publish,
    });
    if (!validation.success) {
      setFormError(
        validation.error.issues[0]?.message ?? "Check the run inputs.",
      );
      return;
    }
    if (publish) {
      setConfirmOpen(true);
      return;
    }
    void launch({ ...validation.data, publishConfirmed: false });
  }

  async function launch(input: OperatorRunRequest) {
    setFormError(null);
    try {
      const started = (await startRun.mutateAsync(input)) as OperatorRunRecord;
      setRunId(started.runId);
      setConfirmOpen(false);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "The run could not start.",
      );
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 lg:px-8 lg:py-10">
      <header className="grid gap-4 border-b border-border pb-7 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="max-w-3xl">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <IconTerminal2 className="size-4" />
            Programming agent
          </div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Turn an issue into verified code.
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
            The agent clones an authorized repository, writes the fix in an
            isolated sandbox, runs your verification command, and publishes only
            after explicit confirmation.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-2 rounded-full bg-emerald-500" />
          Local operator session
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,0.92fr)_minmax(420px,1.08fr)]">
        <form onSubmit={handleSubmit} className="space-y-6">
          <section className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Run specification</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Dry-run stays on this machine and never pushes a branch.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="issue-url">GitHub issue URL</Label>
              <Input
                id="issue-url"
                type="url"
                value={issueUrl}
                onChange={(event) => setIssueUrl(event.target.value)}
                placeholder="https://github.com/owner/repo/issues/123"
                autoComplete="off"
                required
                disabled={busy}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="verify-command">Verification command</Label>
              <Input
                id="verify-command"
                value={verifyCommand}
                onChange={(event) => setVerifyCommand(event.target.value)}
                placeholder="bun test"
                autoComplete="off"
                required
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground">
                Runs independently after the coding agent finishes.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="timeout">Timeout in minutes</Label>
                <Input
                  id="timeout"
                  type="number"
                  min={1}
                  max={60}
                  value={timeoutMinutes}
                  onChange={(event) =>
                    setTimeoutMinutes(Number(event.target.value))
                  }
                  disabled={busy}
                />
              </div>
              <label className="flex cursor-pointer items-center justify-between gap-4 rounded-md border border-border px-4 py-3">
                <span>
                  <span className="block text-sm font-medium">
                    Publish pull request
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Requires confirmation
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={publish}
                  onChange={(event) => setPublish(event.target.checked)}
                  disabled={busy}
                  className="size-4 accent-primary"
                />
              </label>
            </div>
          </section>

          {formError && (
            <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
              {formError}
            </div>
          )}

          <Button
            type="submit"
            size="lg"
            disabled={busy}
            className="w-full sm:w-auto"
          >
            {busy ? (
              <IconLoader2 className="animate-spin" />
            ) : (
              <IconPlayerPlay />
            )}
            {publish ? "Review and publish" : "Start dry run"}
          </Button>
        </form>

        <RunProgress record={record} loading={runQuery.isLoading} />
      </div>

      <Sheet open={confirmOpen} onOpenChange={setConfirmOpen}>
        <SheetContent className="sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Confirm publication</SheetTitle>
            <SheetDescription>
              A successful run will commit the verified changes, push a new
              branch, and open or reuse a pull request in the issue repository.
            </SheetDescription>
          </SheetHeader>
          <div className="my-6 space-y-3 rounded-md border border-border bg-muted/30 p-4 text-sm">
            <p className="font-medium break-all">{issueUrl}</p>
            <p className="font-mono text-xs text-muted-foreground break-all">
              {verifyCommand}
            </p>
          </div>
          <SheetFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Keep as draft
            </Button>
            <Button
              onClick={() =>
                void launch({
                  ...candidate,
                  publish: true,
                  publishConfirmed: true,
                })
              }
              disabled={startRun.isPending}
            >
              {startRun.isPending && <IconLoader2 className="animate-spin" />}
              Publish after verification
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function RunProgress({
  record,
  loading,
}: {
  record?: OperatorRunRecord;
  loading: boolean;
}) {
  const visiblePhases = RUN_PHASES.filter(
    (phase) => phase !== "publish" || record?.request.publish,
  );
  const currentIndex = record ? phaseIndex(record.phase) : -1;

  return (
    <Card className="overflow-hidden border-border bg-card shadow-none">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h2 className="font-semibold">Run evidence</h2>
          <p className="text-xs text-muted-foreground">
            {record ? `Receipt ${record.runId}` : "Waiting for a run"}
          </p>
        </div>
        {record && <StatusBadge record={record} />}
      </div>
      <CardContent className="space-y-6 p-5">
        {!record && !loading ? (
          <div className="flex min-h-72 flex-col items-center justify-center text-center">
            <IconGitPullRequest className="mb-4 size-8 text-muted-foreground" />
            <p className="font-medium">No run selected</p>
            <p className="mt-1 max-w-xs text-sm text-muted-foreground">
              Start with a dry run. Phase updates, changed files, and
              verification results will appear here.
            </p>
          </div>
        ) : (
          <>
            <ol className="grid gap-2 sm:grid-cols-2">
              {visiblePhases.map((phase) => {
                const index = phaseIndex(phase);
                const complete =
                  record?.status === "succeeded" || index < currentIndex;
                const current =
                  index === currentIndex && record?.status === "running";
                return (
                  <li
                    key={phase}
                    className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5 text-sm"
                  >
                    {complete ? (
                      <IconCheck className="size-4 text-emerald-500" />
                    ) : current ? (
                      <IconLoader2 className="size-4 animate-spin text-primary" />
                    ) : (
                      <IconCircle className="size-4 text-muted-foreground/40" />
                    )}
                    {PHASE_LABELS[phase]}
                  </li>
                );
              })}
            </ol>

            {record?.receipt && (
              <div className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
                <Evidence label="Verification">
                  <span
                    className={
                      record.receipt.verification.passed
                        ? "text-emerald-600 dark:text-emerald-400"
                        : ""
                    }
                  >
                    {record.receipt.verification.exitCode === null
                      ? "Pending"
                      : record.receipt.verification.passed
                        ? "Passed"
                        : `Exited ${record.receipt.verification.exitCode}`}
                  </span>
                </Evidence>
                <Evidence label="Changed files">
                  {record.receipt.changedFiles.length || "Pending"}
                </Evidence>
                {record.receipt.branch && (
                  <Evidence label="Branch">{record.receipt.branch}</Evidence>
                )}
                {record.receipt.commitSha && (
                  <Evidence label="Commit">
                    {record.receipt.commitSha.slice(0, 10)}
                  </Evidence>
                )}
              </div>
            )}

            {record?.receipt?.changedFiles.length ? (
              <div className="border-t border-border pt-5">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Changed files
                </p>
                <ul className="space-y-1 font-mono text-xs">
                  {record.receipt.changedFiles.map((file) => (
                    <li key={file} className="break-all">
                      {file}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {record?.message && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {record.message}
              </div>
            )}

            {record?.receipt?.pullRequestUrl && (
              <Button asChild className="w-full">
                <a
                  href={record.receipt.pullRequestUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open pull request <IconExternalLink />
                </a>
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Evidence({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 break-all font-mono text-xs font-medium">{children}</p>
    </div>
  );
}

function StatusBadge({ record }: { record: OperatorRunRecord }) {
  const label =
    record.status === "succeeded"
      ? "Succeeded"
      : record.status === "failed"
        ? "Failed"
        : record.status === "queued"
          ? "Queued"
          : PHASE_LABELS[record.phase];
  const className =
    record.status === "succeeded"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : record.status === "failed"
        ? "border-destructive/30 bg-destructive/10 text-destructive"
        : "border-primary/20 bg-primary/10 text-primary";
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${className}`}
    >
      {label}
    </span>
  );
}
