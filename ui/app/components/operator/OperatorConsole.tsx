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

import type { HostReadinessReport } from "../../../shared/host-readiness";
import {
  buildOperatorChangeEvidence,
  detectRunModeFromUrl,
  isTerminalRun,
  operatorRunRequestSchema,
  phaseIndex,
  resolveOperatorNextAction,
  resolveOperatorPublishConfirmation,
  RUN_PHASES,
  targetUrl,
  type OperatorChangeEvidence,
  type OperatorNextAction,
  type OperatorNextActionView,
  type OperatorRunRecord,
  type OperatorRunRequest,
  type ResolveTargetResult,
} from "../../../shared/operator-run";
import { HostReadinessPanel } from "./HostReadinessPanel";

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
  repositories?: string[];
  repositoryGlobs?: string[];
}

interface VerifyPresetRecommendation {
  presetId: string;
  command: string;
  label: string;
  selectionReason: string;
  source: string;
}

interface VerifyPresetListResponse {
  presets: VerifyPreset[];
  recommendation: VerifyPresetRecommendation;
}

interface OperatorRunListResponse {
  records: OperatorRunRecord[];
  total: number;
  nextCursor?: string;
  retainedCount: number;
  earliestRetainedAt?: string;
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
    bits.push(
      `${item.target.owner}/${item.target.repo} #${item.target.number}`,
    );
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
  const [presetId, setPresetId] = useState("");
  const [verifyCommand, setVerifyCommand] = useState(DEFAULT_VERIFY_COMMAND);
  const [timeoutMinutes, setTimeoutMinutes] = useState(30);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [useRawVerify, setUseRawVerify] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [publishSource, setPublishSource] = useState<OperatorRunRecord | null>(
    null,
  );
  const [runId, setRunId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [historyQueryText, setHistoryQueryText] = useState("");
  const [debouncedHistoryQuery, setDebouncedHistoryQuery] = useState("");
  const [historyStatus, setHistoryStatus] = useState<string>("");
  const [historyMode, setHistoryMode] = useState<string>("");
  const [historyCursor, setHistoryCursor] = useState<string | undefined>(
    undefined,
  );
  const [historyCursorStack, setHistoryCursorStack] = useState<string[]>([]);

  const startRun = useActionMutation("start-shipwright-run");
  const cancelRun = useActionMutation("cancel-shipwright-run");
  const historyQuery = useActionQuery(
    "list-shipwright-runs",
    {
      limit: 50,
      query: debouncedHistoryQuery,
      ...(historyStatus
        ? {
            status: historyStatus as
              | "queued"
              | "running"
              | "succeeded"
              | "failed"
              | "active"
              | "terminal",
          }
        : {}),
      ...(historyMode ? { mode: historyMode as "issue" | "review" } : {}),
      ...(historyCursor ? { cursor: historyCursor } : {}),
      ...(runId ? { selectedRunId: runId } : {}),
    },
    {
      refetchInterval: (query) => {
        const response = query.state.data as
          | OperatorRunListResponse
          | undefined;
        return response?.records.some((item) => !isTerminalRun(item.status))
          ? 1000
          : 5000;
      },
    },
  );
  const presetsQuery = useActionQuery("list-verify-presets", {
    issueUrl: mode === "issue" ? targetInput.trim() : undefined,
    pullRequestUrl: mode === "review" ? targetInput.trim() : undefined,
  });
  const readinessQuery = useActionQuery(
    "get-host-readiness",
    {},
    {
      // Advisory only — no continuous polling beyond normal refetch on focus/refresh.
      refetchInterval: false,
    },
  );
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
  const historyResponse = historyQuery.data as
    | OperatorRunListResponse
    | undefined;
  const history = historyResponse?.records ?? [];
  const historyTotal = historyResponse?.total ?? history.length;
  const historyRetained = historyResponse?.retainedCount ?? history.length;
  const historyEarliest = historyResponse?.earliestRetainedAt;
  const historyNextCursor = historyResponse?.nextCursor;
  const demoMode = historyResponse?.demoMode ?? false;
  const presetResponse = presetsQuery.data as
    | VerifyPresetListResponse
    | VerifyPreset[]
    | undefined;
  const presets = Array.isArray(presetResponse)
    ? presetResponse
    : (presetResponse?.presets ?? []);
  const recommendation = Array.isArray(presetResponse)
    ? undefined
    : presetResponse?.recommendation;
  const readinessReport = readinessQuery.data as
    | HostReadinessReport
    | undefined;
  const liveStartBlocked = Boolean(
    readinessReport &&
    !readinessReport.demoMode &&
    readinessReport.blocksLiveStart,
  );
  const active = Boolean(record && !isTerminalRun(record.status));
  // Intake/dry-run busy only — readiness never blocks dry-run.
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
    const handle = window.setTimeout(() => {
      setDebouncedHistoryQuery(historyQueryText.trim());
      setHistoryCursor(undefined);
      setHistoryCursorStack([]);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [historyQueryText]);

  useEffect(() => {
    // Filter changes reset paging.
    setHistoryCursor(undefined);
    setHistoryCursorStack([]);
  }, [historyStatus, historyMode]);

  useEffect(() => {
    if (useRawVerify) return;
    if (presetId) {
      const preset = presets.find((entry) => entry.id === presetId);
      if (preset) setVerifyCommand(preset.command);
      return;
    }
    if (recommendation?.command) {
      setVerifyCommand(recommendation.command);
    }
  }, [presetId, presets, recommendation, useRawVerify]);

  function buildRequest(publish: boolean): OperatorRunRequest | null {
    if (canPreflight && preflightPending) {
      setFormError("Checking target authorization…");
      return null;
    }
    if (preflight && !preflight.allowed) {
      setFormError(preflight.denyReason ?? "Target is not allowed.");
      return null;
    }
    const issueUrl = mode === "issue" ? targetInput.trim() : "";
    const pullRequestUrl = mode === "review" ? targetInput.trim() : "";
    const candidate = {
      mode,
      issueUrl,
      pullRequestUrl,
      skillId: mode === "review" ? skillId : "",
      presetId: useRawVerify ? "" : presetId,
      useRawVerify,
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
    if (liveStartBlocked) {
      setFormError(
        "Host prerequisites are not ready for live publish. Fix readiness first.",
      );
      return;
    }
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
        if (liveStartBlocked) {
          setFormError(
            "Host prerequisites are not ready for live publish. Fix readiness first.",
          );
          return;
        }
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
    if (liveStartBlocked) {
      setFormError(
        "Host prerequisites are not ready for live publish. Fix readiness first.",
      );
      setConfirmOpen(false);
      setPublishSource(null);
      return;
    }
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

  const confirmation = resolveOperatorPublishConfirmation(publishSource, {
    mode,
    issueUrl: mode === "issue" ? targetInput.trim() : "",
    pullRequestUrl: mode === "review" ? targetInput.trim() : "",
    skillId: mode === "review" ? skillId : "",
    verifyCommand,
  });
  const confirmTarget = confirmation.target;
  const confirmVerify = confirmation.verifyCommand;
  const confirmMode = confirmation.mode;
  const confirmSkillId = confirmation.skillId;
  const pinnedSha = confirmation.pinnedSha;
  const changeEvidence = buildOperatorChangeEvidence(publishSource);

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

      <HostReadinessPanel
        report={readinessReport}
        loading={readinessQuery.isLoading}
        onRefresh={() => void readinessQuery.refetch()}
        refreshing={readinessQuery.isFetching}
      />

      <div className="grid gap-8 xl:grid-cols-[240px_minmax(0,0.92fr)_minmax(420px,1.08fr)] lg:grid-cols-[minmax(0,0.92fr)_minmax(420px,1.08fr)]">
        <aside className="space-y-3 lg:order-first xl:order-none">
          <div>
            <h2 className="text-sm font-semibold">Run history</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Durable records survive refresh.
            </p>
          </div>
          <div className="space-y-2">
            <Input
              value={historyQueryText}
              onChange={(event) => setHistoryQueryText(event.target.value)}
              placeholder="Search target, summary, run id"
              className="h-8 text-xs"
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                value={historyStatus}
                onChange={(event) => setHistoryStatus(event.target.value)}
                className="flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none"
              >
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="terminal">Terminal</option>
                <option value="succeeded">Succeeded</option>
                <option value="failed">Failed</option>
                <option value="queued">Queued</option>
                <option value="running">Running</option>
              </select>
              <select
                value={historyMode}
                onChange={(event) => setHistoryMode(event.target.value)}
                className="flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none"
              >
                <option value="">All modes</option>
                <option value="issue">Issue</option>
                <option value="review">Review</option>
              </select>
            </div>
            <p className="text-[10px] text-muted-foreground">
              {historyTotal} match{historyTotal === 1 ? "" : "es"} · retained{" "}
              {historyRetained}
              {historyEarliest
                ? ` · since ${new Date(historyEarliest).toLocaleDateString()}`
                : ""}
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
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={historyCursorStack.length === 0}
              onClick={() => {
                const stack = [...historyCursorStack];
                const prev = stack.pop();
                setHistoryCursorStack(stack);
                setHistoryCursor(prev);
              }}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!historyNextCursor}
              onClick={() => {
                if (!historyNextCursor) return;
                setHistoryCursorStack((stack) => [
                  ...stack,
                  historyCursor ?? "",
                ]);
                setHistoryCursor(historyNextCursor);
              }}
            >
              Next
            </Button>
          </div>
        </aside>

        <form onSubmit={handleDryRun} className="space-y-6">
          <section className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Run specification</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Dry-run stays on this machine and never pushes a branch.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="target-url">
                GitHub issue or pull request URL
              </Label>
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
                <p className="text-xs text-destructive">
                  {preflight.denyReason}
                </p>
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
                <option value="">
                  {recommendation
                    ? `Recommended for this target (${recommendation.label})`
                    : "Recommended for this target"}
                </option>
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
              {!useRawVerify && (
                <p className="text-xs text-muted-foreground">
                  {presetId
                    ? `Using operator-selected preset ${presetId}.`
                    : recommendation?.selectionReason ??
                      "Server will choose the default verification preset for this target."}
                </p>
              )}
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

          {liveStartBlocked ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Host prerequisites are not ready. Live publish is disabled until
              provider, GitHub App, Docker socket, and state store report ready.
              Dry-run and history remain available.
            </p>
          ) : null}
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
              disabled={busy || liveStartBlocked}
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
          {changeEvidence ? (
            <ChangeEvidenceCard evidence={changeEvidence} />
          ) : null}
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
              disabled={startRun.isPending || liveStartBlocked}
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


function formatEvidenceSha(value: string | undefined): string {
  if (!value) return "";
  return value.length > 10 ? value.slice(0, 10) : value;
}

function formatEvidenceDuration(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec ? `${min}m ${sec}s` : `${min}m`;
}

function ChangeEvidenceCard({ evidence }: { evidence: OperatorChangeEvidence }) {
  const duration = formatEvidenceDuration(evidence.durationMs);
  return (
    <div className="mb-6 space-y-3 rounded-md border border-border p-4 text-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Prior dry-run evidence
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          From run {evidence.sourceRunId}
          {` · started ${new Date(evidence.startedAt).toLocaleString()}`}
          {duration ? ` · ${duration}` : ""}
          {evidence.finishedAt
            ? ` · finished ${new Date(evidence.finishedAt).toLocaleString()}`
            : ""}
          . Publication starts a new run and re-verifies; it does not promote this
          workspace.
        </p>
      </div>
      <dl className="grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Verification</dt>
          <dd className="font-medium">
            {evidence.verification.passed
              ? "Passed"
              : evidence.verification.exitCode == null
                ? "Pending"
                : `Failed (exit ${evidence.verification.exitCode})`}
          </dd>
          <dd className="font-mono text-xs text-muted-foreground break-all">
            {evidence.verification.command}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Changed files</dt>
          <dd className="font-medium">{evidence.changedFileCount}</dd>
        </div>
        {evidence.baseSha ? (
          <div>
            <dt className="text-xs text-muted-foreground">Pinned head</dt>
            <dd className="font-mono text-xs">{formatEvidenceSha(evidence.baseSha)}</dd>
          </div>
        ) : null}
        {evidence.commitSha ? (
          <div>
            <dt className="text-xs text-muted-foreground">Commit</dt>
            <dd className="font-mono text-xs">{formatEvidenceSha(evidence.commitSha)}</dd>
          </div>
        ) : null}
        {evidence.branch ? (
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Branch</dt>
            <dd className="font-mono text-xs break-all">{evidence.branch}</dd>
          </div>
        ) : null}
        {evidence.pullRequestUrl ? (
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Prior pull request</dt>
            <dd className="font-mono text-xs break-all">{evidence.pullRequestUrl}</dd>
          </div>
        ) : null}
      </dl>
      {evidence.changedFiles.length > 0 ? (
        <div>
          <p className="mb-1 text-xs text-muted-foreground">
            Files
            {evidence.changedFilesTruncated
              ? ` (first ${evidence.changedFiles.length} of ${evidence.changedFileCount})`
              : ""}
          </p>
          <ul className="max-h-36 space-y-1 overflow-auto font-mono text-xs">
            {evidence.changedFiles.map((file) => (
              <li key={file} className="break-all">
                {file}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
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
              Paste a GitHub URL and start a dry run. History, phase updates,
              and the next action will appear here.
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
                  {record?.verifySelectionReason && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Verify: {record.verifySelectionReason}
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
                    disabled={
                      actionPending || nextActions.primary.type === "none"
                    }
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

            {record?.events && record.events.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Phase timeline
                </p>
                <ol className="space-y-2">
                  {record.events.map((event, index) => {
                    const terminal =
                      event.kind === "succeeded" ||
                      event.kind === "failed" ||
                      event.kind === "cancelled" ||
                      event.kind === "interrupted";
                    return (
                      <li
                        key={`${event.at}-${event.kind}-${event.phase}-${index}`}
                        className={
                          terminal
                            ? "rounded-md border border-border bg-muted/20 px-3 py-2"
                            : "rounded-md border border-border/70 px-3 py-2"
                        }
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p
                              className={
                                terminal
                                  ? "text-sm font-semibold"
                                  : "text-sm font-medium"
                              }
                            >
                              {event.summary}
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {PHASE_LABELS[event.phase]} · {event.status}
                            </p>
                          </div>
                          <time
                            className="shrink-0 font-mono text-[11px] text-muted-foreground"
                            dateTime={event.at}
                          >
                            {new Date(event.at).toLocaleTimeString()}
                          </time>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ) : null}

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
