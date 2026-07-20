import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import {
  IconAlertTriangle,
  IconCheck,
  IconCircle,
  IconExternalLink,
  IconGitPullRequest,
  IconLoader2,
  IconPlayerPlay,
  IconPlayerStop,
  IconTerminal2,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

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
  detectRunModeFromUrl,
  isTerminalRun,
  operatorRunRequestSchema,
  phaseIndex,
  resolveOperatorNextAction,
  RUN_PHASES,
  targetUrl,
  type OperatorNextAction,
  type OperatorNextActionView,
  type OperatorRunRecord,
  type OperatorRunRequest,
  type ResolveTargetResult,
} from "../../../shared/operator-run";

const PHASE_LABELS = {
  intake: "Intake",
  workspace: "Workspace",
  agent: "Agent",
  verify: "Verify",
  policy: "Policy",
  publish: "Publish",
  threads: "Threads",
  complete: "Complete",
} as const;

const DEFAULT_VERIFY_COMMAND = "bun test";
const DEFAULT_SKILL_ID = "fix-review-findings";

interface VerifyPreset {
  id: string;
  label: string;
  command: string;
}

interface OperatorRunListResponse {
  records: OperatorRunRecord[];
  demoMode: boolean;
}

function formatDuration(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec ? `${min}m ${sec}s` : `${min}m`;
}

function historyTitle(item: OperatorRunRecord): string {
  if (item.target?.title) return item.target.title;
  if (item.target) {
    return `${item.target.owner}/${item.target.repo} #${item.target.number}`;
  }
  return targetUrl(item.request) || item.runId;
}

function historyMeta(item: OperatorRunRecord): string {
  const bits: string[] = [];
  if (item.target) {
    bits.push(`${item.target.owner}/${item.target.repo} #${item.target.number}`);
  }
  const duration = formatDuration(item.durationMs);
  if (duration) bits.push(duration);
  if (item.summary) bits.push(item.summary);
  return bits.join(" · ");
}

export function OperatorConsole() {
  const [targetInput, setTargetInput] = useState("");
  const [mode, setMode] = useState<"issue" | "review">("issue");
  const [skillId, setSkillId] = useState(DEFAULT_SKILL_ID);
  const [presetId, setPresetId] = useState("bun-test");
  const [verifyCommand, setVerifyCommand] = useState(DEFAULT_VERIFY_COMMAND);
  const [timeoutMinutes, setTimeoutMinutes] = useState(30);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [useRawVerify, setUseRawVerify] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [publishSource, setPublishSource] = useState<OperatorRunRecord | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const startRun = useActionMutation("start-shipwright-run");
  const cancelRun = useActionMutation("cancel-shipwright-run");
  const historyQuery = useActionQuery(
    "list-shipwright-runs",
    { limit: 50 },
    {
      refetchInterval: (query) => {
        const response = query.state.data as OperatorRunListResponse | undefined;
        return response?.records.some((item) => !isTerminalRun(item.status))
          ? 1000
          : 5000;
      },
    },
  );
  const presetsQuery = useActionQuery("list-verify-presets", {});
  const trimmedTarget = targetInput.trim();
  const canPreflight = Boolean(detectRunModeFromUrl(trimmedTarget));
  const targetQuery = useActionQuery(
    "resolve-target",
    { url: trimmedTarget },
    { enabled: canPreflight && trimmedTarget.length > 0 },
  );
  const preflightRaw = targetQuery.data as ResolveTargetResult | undefined;
  const preflightPending =
    canPreflight &&
    (targetQuery.isLoading || targetQuery.isFetching) &&
    trimmedTarget.length > 0;
  const preflight =
    preflightRaw?.url === trimmedTarget ? preflightRaw : undefined;
  const runQuery = useActionQuery(
    "get-shipwright-run",
    runId ? { runId } : {},
    {
      refetchInterval: (query) => {
        const record = query.state.data as OperatorRunRecord | undefined;
        return record && isTerminalRun(record.status) ? false : 500;
      },
    },
  );

  const record = runQuery.data as OperatorRunRecord | undefined;
  const historyResponse = historyQuery.data as OperatorRunListResponse | undefined;
  const history = historyResponse?.records ?? [];
  const demoMode = historyResponse?.demoMode ?? false;
  const presets = (presetsQuery.data as VerifyPreset[] | undefined) ?? [];
  const active = Boolean(record && !isTerminalRun(record.status));
  const busy = startRun.isPending || active || preflightPending;
  const nextActions = useMemo(
    () => (record ? resolveOperatorNextAction(record) : null),
    [record],
  );

  useEffect(() => {
    const detected = detectRunModeFromUrl(targetInput);
    if (detected) setMode(detected);
  }, [targetInput]);

  useEffect(() => {
    if (!useRawVerify && presetId) {
      const preset = presets.find((entry) => entry.id === presetId);
      if (preset) setVerifyCommand(preset.command);
    }
  }, [presetId, presets, useRawVerify]);

  function buildRequest(publish: boolean): OperatorRunRequest | null {
    if (canPreflight && preflightPending) {
      setFormError("Checking target authorization…");
      return null;
    }
    if (preflight && !preflight.allowed) {
      setFormError(preflight.denyReason ?? "Target is not allowed.");
      return null;
    }
    const issueUrl =
      mode === "issue" ? targetInput.trim() : "";
    const pullRequestUrl =
      mode === "review" ? targetInput.trim() : "";
    const candidate = {
      mode,
      issueUrl,
      pullRequestUrl,
      skillId: mode === "review" ? skillId : "",
      presetId: useRawVerify ? "" : presetId,
      verifyCommand,
      timeoutMinutes,
      publish,
      publishConfirmed: publish,
    };
    const validation = operatorRunRequestSchema.safeParse(candidate);
    if (!validation.success) {
      setFormError(
        validation.error.issues[0]?.message ?? "Check the run inputs.",
      );
      return null;
    }
    return validation.data;
  }

  async function launch(input: OperatorRunRequest) {
    setFormError(null);
    try {
      const started = (await startRun.mutateAsync(input)) as OperatorRunRecord;
      setRunId(started.runId);
      setConfirmOpen(false);
      setPublishSource(null);
      void historyQuery.refetch();
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "The run could not start.",
      );
    }
  }

  function handleDryRun(event?: FormEvent) {
    event?.preventDefault();
    setFormError(null);
    const request = buildRequest(false);
    if (!request) return;
    void launch({ ...request, publish: false, publishConfirmed: false });
  }

  function handlePublishClick() {
    setFormError(null);
    setPublishSource(null);
    const request = buildRequest(true);
    if (!request) return;
    setConfirmOpen(true);
  }

  async function handleCancel() {
    if (!runId) return;
    setFormError(null);
    try {
      await cancelRun.mutateAsync({ runId });
      void runQuery.refetch();
      void historyQuery.refetch();
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "The run could not be cancelled.",
      );
    }
  }

  async function handleNextAction(action: OperatorNextAction) {
    setFormError(null);
    if (action.type === "cancel") {
      await handleCancel();
      return;
    }
    if (action.type === "open_url" && action.url) {
      window.open(action.url, "_blank", "noreferrer");
      return;
    }
    if (action.type === "fix_target") {
      setFormError("Update the GitHub URL (and allowlist) then start again.");
      return;
    }
    if (
      action.type === "retry_dry_run" ||
      action.type === "edit_verify_retry" ||
      action.type === "start_publish_run"
    ) {
      if (!action.runId) return;
      if (action.type === "edit_verify_retry") {
        if (!record || record.runId !== action.runId) return;
        setTargetInput(targetUrl(record.request));
        setMode(record.request.mode);
        setSkillId(record.request.skillId || DEFAULT_SKILL_ID);
        setPresetId("");
        setVerifyCommand(record.request.verifyCommand);
        setTimeoutMinutes(record.request.timeoutMinutes);
        setAdvancedOpen(true);
        setUseRawVerify(true);
        setFormError("Edit the verification command, then start a dry-run.");
        return;
      }
      if (action.type === "start_publish_run") {
        if (!record || record.runId !== action.runId) return;
        setPublishSource(record);
            setConfirmOpen(true);
        return;
      }
      try {
        const started = (await startRun.mutateAsync({
          fromRunId: action.runId,
          verifyCommand: record?.request.verifyCommand ?? verifyCommand,
          publish: false,
          publishConfirmed: false,
          timeoutMinutes: record?.request.timeoutMinutes ?? timeoutMinutes,
        })) as OperatorRunRecord;
        setRunId(started.runId);
        void historyQuery.refetch();
      } catch (error) {
        setFormError(
          error instanceof Error ? error.message : "Could not retry run.",
        );
      }
    }
  }

  async function confirmPublish() {
    setFormError(null);
    try {
      if (publishSource) {
        const started = (await startRun.mutateAsync({
          fromRunId: publishSource.runId,
          verifyCommand: publishSource.request.verifyCommand,
          publish: true,
          publishConfirmed: true,
          timeoutMinutes: publishSource.request.timeoutMinutes,
        })) as OperatorRunRecord;
        setRunId(started.runId);
        setConfirmOpen(false);
          setPublishSource(null);
        void historyQuery.refetch();
        return;
      }
      const request = buildRequest(true);
      if (!request) return;
      await launch({ ...request, publish: true, publishConfirmed: true });
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "Publish run could not start.",
      );
    }
  }

  const confirmRecord =
    publishSource?.request.publish === false ? publishSource : undefined;
  const confirmTarget = confirmRecord
    ? targetUrl(confirmRecord.request)
    : targetInput;
  const confirmVerify = confirmRecord
    ? confirmRecord.request.verifyCommand
    : verifyCommand;
  const confirmMode = confirmRecord?.request.mode ?? mode;
  const confirmSkillId = confirmRecord?.request.skillId ?? skillId;
  const pinnedSha = confirmRecord?.receipt?.baseSha
    ? confirmRecord.receipt.baseSha.slice(0, 7)
    : null;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 lg:px-8 lg:py-10">
      <header className="grid gap-4 border-b border-border pb-7 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="max-w-3xl">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <IconTerminal2 className="size-4" />
            Shipwright
          </div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Operator console
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
            Paste a GitHub issue or PR, dry-run first, then start a separate
            publish run when ready. Credentials stay on the host.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2 rounded-full border border-border px-2.5 py-1 font-medium">
            <span
              className={`size-2 rounded-full ${demoMode ? "bg-amber-500" : "bg-emerald-500"}`}
            />
            {demoMode ? "Demo mode" : "Live"}
          </span>
          <span>Private operator service</span>
        </div>
      </header>

      <div className="grid gap-8 xl:grid-cols-[240px_minmax(0,0.92fr)_minmax(420px,1.08fr)] lg:grid-cols-[minmax(0,0.92fr)_minmax(420px,1.08fr)]">
        <aside className="space-y-3 lg:order-first xl:order-none">
          <div>
            <h2 className="text-sm font-semibold">Run history</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Durable records survive refresh.
            </p>
          </div>
          <ul className="max-h-[32rem] space-y-2 overflow-auto">
            {history.length === 0 ? (
              <li className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                No runs yet.
              </li>
            ) : (
              history.map((item) => {
                const selected = item.runId === runId;
                return (
                  <li key={item.runId}>
                    <button
                      type="button"
                      onClick={() => setRunId(item.runId)}
                      className={`w-full rounded-md border px-3 py-2 text-left transition ${
                        selected
                          ? "border-primary bg-primary/5"
                          : "border-border hover:bg-muted/40"
                      }`}
                    >
                      <span className="block text-xs font-medium leading-snug">
                        {historyTitle(item)}
                      </span>
                      <span className="mt-1 block text-[11px] text-muted-foreground">
                        {item.status === "succeeded"
                          ? "Succeeded"
                          : item.status === "failed"
                            ? "Failed"
                            : item.status === "queued"
                              ? "Queued"
                              : PHASE_LABELS[item.phase]}
                      </span>
                      <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                        {historyMeta(item)}
                      </span>
                      <span className="mt-1 block font-mono text-[10px] text-muted-foreground/80">
                        {item.runId.slice(0, 10)}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </aside>

        <form
          onSubmit={handleDryRun}
          className="space-y-6"
        >
          <section className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Run specification</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Dry-run stays on this machine and never pushes a branch.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="target-url">GitHub issue or pull request URL</Label>
              <Input
                id="target-url"
                type="url"
                value={targetInput}
                onChange={(event) => setTargetInput(event.target.value)}
                placeholder="https://github.com/owner/repo/issues/123"
                autoComplete="off"
                required
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground">
                Detected workflow:{" "}
                <span className="font-medium text-foreground">
                  {mode === "review"
                    ? "Review existing pull request"
                    : "Issue to pull request"}
                </span>
              </p>
              {preflight?.allowed && preflight.title ? (
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {preflight.title}
                  </span>
                  {preflight.pinned?.headSha ? (
                    <>
                      {" "}
                      · pinned head{" "}
                      <span className="font-mono">
                        {preflight.pinned.headSha.slice(0, 7)}
                      </span>
                    </>
                  ) : null}
                  {preflight.pinned?.openThreadCount != null ? (
                    <> · {preflight.pinned.openThreadCount} open thread(s)</>
                  ) : null}
                </p>
              ) : null}
              {preflightPending ? (
                <p className="text-xs text-muted-foreground">
                  Checking target authorization…
                </p>
              ) : null}
              {preflight && !preflight.allowed ? (
                <p className="text-xs text-destructive">{preflight.denyReason}</p>
              ) : null}
            </div>

            {mode === "review" && (
              <div className="space-y-2">
                <Label htmlFor="skill-id">Review skill</Label>
                <select
                  id="skill-id"
                  value={skillId}
                  disabled={busy}
                  onChange={(event) => setSkillId(event.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none"
                >
                  <option value="fix-review-findings">
                    fix-review-findings
                  </option>
                </select>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="verify-preset">Verification preset</Label>
              <select
                id="verify-preset"
                value={useRawVerify ? "" : presetId}
                disabled={busy || useRawVerify}
                onChange={(event) => {
                  setUseRawVerify(false);
                  setPresetId(event.target.value);
                }}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none"
              >
                {(presets.length
                  ? presets
                  : [
                      {
                        id: "bun-test",
                        label: "bun test",
                        command: "bun test",
                      },
                    ]
                ).map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
              <p className="font-mono text-xs text-muted-foreground">
                {verifyCommand}
              </p>
            </div>

            <details
              open={advancedOpen}
              onToggle={(event) =>
                setAdvancedOpen((event.target as HTMLDetailsElement).open)
              }
              className="rounded-md border border-border px-3 py-2"
            >
              <summary className="cursor-pointer text-sm font-medium">
                Advanced
              </summary>
              <div className="mt-4 space-y-4">
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
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={useRawVerify}
                    disabled={busy}
                    onChange={(event) => setUseRawVerify(event.target.checked)}
                  />
                  Use raw verification command
                </label>
                {useRawVerify && (
                  <div className="space-y-2">
                    <Label htmlFor="verify-command">Verification command</Label>
                    <Input
                      id="verify-command"
                      value={verifyCommand}
                      onChange={(event) => setVerifyCommand(event.target.value)}
                      disabled={busy}
                    />
                  </div>
                )}
              </div>
            </details>
          </section>

          {formError && (
            <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
              {formError}
            </div>
          )}

          <div className="flex flex-wrap gap-3">
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
              Dry run
            </Button>
            <Button
              type="button"
              size="lg"
              variant="outline"
              disabled={busy}
              onClick={handlePublishClick}
              className="w-full sm:w-auto"
            >
              Publish…
            </Button>
            {active && (
              <Button
                type="button"
                size="lg"
                variant="outline"
                disabled={cancelRun.isPending}
                onClick={() => void handleCancel()}
                className="w-full sm:w-auto"
              >
                {cancelRun.isPending ? (
                  <IconLoader2 className="animate-spin" />
                ) : (
                  <IconPlayerStop />
                )}
                Cancel run
              </Button>
            )}
          </div>
        </form>

        <RunProgress
          record={record}
          loading={runQuery.isLoading}
          nextActions={nextActions}
          onAction={(action) => void handleNextAction(action)}
          actionPending={startRun.isPending || cancelRun.isPending}
        />
      </div>

      <Sheet
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) {
                  setPublishSource(null);
          }
        }}
      >
        <SheetContent className="sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Confirm publication run</SheetTitle>
            <SheetDescription>
              This starts a <strong>new</strong> publish run with the same
              inputs. The agent reruns and may produce a different diff. It does
              not promote a prior dry-run workspace. The run re-authorizes and
              re-verifies before any push.
              {pinnedSha ? ` Prior pinned head: ${pinnedSha}.` : ""}
            </SheetDescription>
          </SheetHeader>
          <div className="my-6 space-y-3 rounded-md border border-border bg-muted/30 p-4 text-sm">
            <p className="font-medium break-all">{confirmTarget}</p>
            {confirmMode === "review" && (
              <p className="font-mono text-xs text-muted-foreground break-all">
                skill: {confirmSkillId}
              </p>
            )}
            <p className="font-mono text-xs text-muted-foreground break-all">
              {confirmVerify}
            </p>
            {demoMode && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Demo mode will refuse real publish after confirm.
              </p>
            )}
          </div>
          <SheetFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmOpen(false);
                          setPublishSource(null);
              }}
            >
              Keep as draft
            </Button>
            <Button
              onClick={() => void confirmPublish()}
              disabled={startRun.isPending}
            >
              {startRun.isPending && <IconLoader2 className="animate-spin" />}
              Start publish run
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
  nextActions,
  onAction,
  actionPending,
}: {
  record?: OperatorRunRecord;
  loading: boolean;
  nextActions: OperatorNextActionView | null;
  onAction: (action: OperatorNextAction) => void;
  actionPending: boolean;
}) {
  const visiblePhases = RUN_PHASES.filter((phase) => {
    if (phase === "publish") return Boolean(record?.request.publish);
    if (phase === "threads")
      return record?.kind === "review" || record?.request.mode === "review";
    return true;
  });
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
              Paste a GitHub URL and start a dry run. History, phase updates, and
              the next action will appear here.
            </p>
          </div>
        ) : (
          <>
            {nextActions && (
              <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Status
                  </p>
                  <p className="mt-1 text-base font-semibold">
                    {nextActions.headline}
                  </p>
                  {record?.operatorHint && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {record.operatorHint}
                    </p>
                  )}
                  {nextActions.primary.caveat && (
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      {nextActions.primary.caveat}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={actionPending || nextActions.primary.type === "none"}
                    onClick={() => onAction(nextActions.primary)}
                  >
                    {actionPending ? (
                      <IconLoader2 className="animate-spin" />
                    ) : null}
                    {nextActions.primary.label}
                  </Button>
                  {nextActions.secondary.map((action) => (
                    <Button
                      key={`${action.type}-${action.label}`}
                      type="button"
                      variant="outline"
                      disabled={actionPending}
                      onClick={() => onAction(action)}
                    >
                      {action.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}

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
                <Evidence label="Provider">
                  {record.receipt.execution.provider}/
                  {record.receipt.execution.model}
                </Evidence>
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
                {record.durationMs != null && (
                  <Evidence label="Duration">
                    {formatDuration(record.durationMs)}
                  </Evidence>
                )}
                {record.receipt.branch && (
                  <Evidence label="Branch">{record.receipt.branch}</Evidence>
                )}
                {record.receipt.commitSha && (
                  <Evidence label="Commit">
                    {record.receipt.commitSha.slice(0, 10)}
                  </Evidence>
                )}
                {record.receipt.baseSha && (
                  <Evidence label="Pinned head">
                    {record.receipt.baseSha.slice(0, 10)}
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

            {record?.receipt &&
              !record.receipt.verification.passed &&
              (record.receipt.verification.stderrTail ||
                record.receipt.verification.stdoutTail) && (
                <div className="space-y-3 border-t border-border pt-5">
                  {record.receipt.verification.stderrTail && (
                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Verification stderr
                      </p>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
                        {record.receipt.verification.stderrTail}
                      </pre>
                    </div>
                  )}
                  {record.receipt.verification.stdoutTail && (
                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Verification stdout
                      </p>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
                        {record.receipt.verification.stdoutTail}
                      </pre>
                    </div>
                  )}
                </div>
              )}

            {(record?.receipt?.errorMessage ?? record?.message) && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {record.receipt?.errorMessage ?? record.message}
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
