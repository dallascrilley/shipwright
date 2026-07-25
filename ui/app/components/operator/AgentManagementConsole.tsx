import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import {
  IconAlertTriangle,
  IconArchive,
  IconArrowsExchange,
  IconBolt,
  IconBrandGithub,
  IconCheck,
  IconCircle,
  IconClock,
  IconCopy,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShieldCheck,
  IconPlayerStop,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useState, type FormEvent } from "react";

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

import type {
  ActionPreset,
  AgentDraft,
  AgentDefinition,
  AgentTrigger,
  GithubTriggerCondition,
  GithubTriggerConditionField,
  GithubTriggerConditionInput,
} from "../../../shared/agent-definition";
import {
  ACTION_PRESET_CHOICES,
  GITHUB_TRIGGER_CONDITION_CATALOG,
  GITHUB_TRIGGER_CONDITION_LIMITS,
  GITHUB_TRIGGER_CHOICES,
  defaultSkillIdForActionPreset,
  type GithubTriggerChoiceId,
} from "../../../shared/agent-definition";
import type {
  AgentDefinitionExport,
  AgentDetailView,
  AgentListItem,
  AgentListFilter,
  AgentTriggerView,
} from "../../../shared/agent-management";
import {
  buildRepositoryPickerView,
  canSaveRepositorySelection,
  type AgentRepositoryCatalogResult,
  type RepositoryPickerOption,
} from "../../../shared/repository-catalog";

const DEFAULT_DRAFT: AgentDraft = {
  name: "",
  instructions: "",
  actionPreset: "fix_issue",
  skillId: "",
  allowedTools: ["github", "terminal"],
  targetScope: { repository: "", branch: "main" },
  verification: { presetId: "bun-test" },
  publicationPolicy: "dry_run",
  cancelInFlight: true,
};

type DraftForm = {
  name: string;
  instructions: string;
  actionPreset: ActionPreset;
  skillId: string;
  allowedTools: string;
  repository: string;
  branch: string;
  presetId: string;
  publicationPolicy: AgentDraft["publicationPolicy"];
  failureThreshold: string;
  cancelInFlight: boolean;
};

type ConfirmationKind = "enable" | "disable" | "stop";

type GithubConditionDraft = GithubTriggerCondition;

function conditionAllowedForEvent(
  field: GithubTriggerConditionField,
  event: "issues" | "pull_request",
): boolean {
  const definition = GITHUB_TRIGGER_CONDITION_CATALOG.find(
    (item) => item.field === field,
  );
  return Boolean(
    definition && (definition.events as readonly string[]).includes(event),
  );
}

function createGithubConditionDraft(
  field: GithubTriggerConditionField,
): GithubConditionDraft {
  switch (field) {
    case "actor":
      return { field, operator: "is_one_of", values: [""] };
    case "labels":
      return { field, operator: "include_any", values: [""] };
    case "base_branch":
      return { field, operator: "is_one_of", values: [""] };
    case "draft_state":
      return { field, operator: "is_not_draft" };
  }
}

function toGithubTriggerConditionInput(
  condition: GithubConditionDraft,
): GithubTriggerConditionInput {
  return structuredClone(condition);
}

function toDraftForm(draft: AgentDraft): DraftForm {
  return {
    name: draft.name,
    instructions: draft.instructions,
    actionPreset: draft.actionPreset,
    skillId: draft.skillId,
    allowedTools: draft.allowedTools.join(", "),
    repository: draft.targetScope.repository,
    branch: draft.targetScope.branch ?? "",
    presetId: draft.verification.presetId,
    publicationPolicy: draft.publicationPolicy,
    failureThreshold: draft.failureThreshold?.toString() ?? "",
    cancelInFlight: draft.cancelInFlight ?? false,
  };
}

function applyActionPresetChange(
  form: DraftForm,
  nextPreset: ActionPreset,
): DraftForm {
  const previousDefault = defaultSkillIdForActionPreset(form.actionPreset);
  const nextDefault = defaultSkillIdForActionPreset(nextPreset);
  const shouldUpdateSkill =
    !form.skillId.trim() || form.skillId === previousDefault;
  return {
    ...form,
    actionPreset: nextPreset,
    skillId: shouldUpdateSkill ? nextDefault : form.skillId,
  };
}

function toDraft(form: DraftForm): AgentDraft {
  const allowedTools = form.allowedTools
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    name: form.name,
    instructions: form.instructions,
    actionPreset: form.actionPreset,
    skillId: form.skillId,
    allowedTools,
    targetScope: {
      repository: form.repository,
      ...(form.branch ? { branch: form.branch } : {}),
    },
    verification: { presetId: form.presetId },
    publicationPolicy: form.publicationPolicy,
    ...(form.failureThreshold
      ? { failureThreshold: Number(form.failureThreshold) }
      : {}),
    cancelInFlight: form.cancelInFlight,
  };
}

function formatTime(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function percent(value: number | undefined): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function policyLabel(policy: AgentDraft["publicationPolicy"]): string {
  if (policy === "dry_run") return "Dry run only";
  if (policy === "approval_required") return "Approval required";
  return "Publish allowed";
}

function stateTone(state: string): string {
  if (["succeeded", "idle"].includes(state)) return "bg-emerald-500";
  if (["failed", "dead_letter"].includes(state)) return "bg-rose-500";
  if (["paused", "cancelled", "interrupted"].includes(state))
    return "bg-amber-500";
  return "bg-sky-500";
}

function mutationMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function AgentManagementConsole() {
  const [filter, setFilter] = useState<AgentListFilter>({
    query: "",
    enabled: "all",
    health: "all",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<DraftForm>(() =>
    toDraftForm(DEFAULT_DRAFT),
  );
  const [draftForm, setDraftForm] = useState<DraftForm>(() =>
    toDraftForm(DEFAULT_DRAFT),
  );
  const [triggerKind, setTriggerKind] = useState<"github" | "schedule">(
    "github",
  );
  const [githubChoiceId, setGithubChoiceId] =
    useState<GithubTriggerChoiceId>("issue_created");
  const [githubConditions, setGithubConditions] = useState<
    GithubConditionDraft[]
  >([]);
  const [replacementTriggerId, setReplacementTriggerId] = useState<
    string | null
  >(null);
  const [triggerToRemove, setTriggerToRemove] =
    useState<AgentTriggerView | null>(null);
  const [createRepositoryQuery, setCreateRepositoryQuery] = useState("");
  const [draftRepositoryQuery, setDraftRepositoryQuery] = useState("");
  const [schedule, setSchedule] = useState("*/5 * * * *");
  const [timezone, setTimezone] = useState("UTC");
  const [triggerTargetKind, setTriggerTargetKind] = useState<"issue" | "pull">(
    "issue",
  );
  const [triggerTargetNumber, setTriggerTargetNumber] = useState("1");
  const [testTargetKind, setTestTargetKind] = useState<"issue" | "pull">(
    "issue",
  );
  const [testTargetNumber, setTestTargetNumber] = useState("1");
  const [confirmation, setConfirmation] = useState<ConfirmationKind | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);

  const listQuery = useActionQuery("list-agents", filter, {
    refetchInterval: 5_000,
  });
  const detailQuery = useActionQuery(
    "get-agent",
    { agentId: selectedId ?? "" },
    { enabled: selectedId !== null, refetchInterval: 5_000 },
  );
  const repositoryQuery = useActionQuery(
    "list-agent-repositories",
    {},
    {
      refetchInterval: 60_000,
    },
  );
  const exportQuery = useActionQuery(
    "export-agent-definition",
    { agentId: selectedId ?? "" },
    { enabled: selectedId !== null },
  );
  const createAgent = useActionMutation("create-agent");
  const saveAgent = useActionMutation("save-agent");
  const createTrigger = useActionMutation("create-agent-trigger");
  const replaceTrigger = useActionMutation("replace-agent-trigger");
  const removeTrigger = useActionMutation("remove-agent-trigger");
  const setEnabled = useActionMutation("set-agent-enabled");
  const setSchedulePaused = useActionMutation("set-schedule-trigger-paused");
  const stopAgent = useActionMutation("emergency-stop-agent");
  const queueTestRun = useActionMutation("queue-agent-test-run");

  const agents = (listQuery.data as AgentListItem[] | undefined) ?? [];
  const detail = detailQuery.data as AgentDetailView | undefined;
  const repositoryCatalog = repositoryQuery.data as
    | AgentRepositoryCatalogResult
    | undefined;
  const busy =
    createAgent.isPending ||
    saveAgent.isPending ||
    createTrigger.isPending ||
    replaceTrigger.isPending ||
    removeTrigger.isPending ||
    setEnabled.isPending ||
    setSchedulePaused.isPending ||
    stopAgent.isPending ||
    queueTestRun.isPending;

  useEffect(() => {
    if (!selectedId && agents[0]) setSelectedId(agents[0].agentId);
    if (selectedId && !agents.some((item) => item.agentId === selectedId)) {
      setSelectedId(agents[0]?.agentId ?? null);
    }
  }, [agents, selectedId]);

  useEffect(() => {
    if (detail) {
      setDraftForm(toDraftForm(detail.config));
      setReplacementTriggerId(null);
      setGithubConditions([]);
    }
  }, [detail?.agentId, detail?.currentRevision]);

  async function refresh() {
    await Promise.all([listQuery.refetch(), detailQuery.refetch()]);
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      const created = (await createAgent.mutateAsync(
        toDraft(createForm),
      )) as AgentDefinition;
      setSelectedId(created.agentId);
      setCreateOpen(false);
      setCreateForm(toDraftForm(DEFAULT_DRAFT));
      setCreateRepositoryQuery("");
      setMessage(
        "Disabled draft created. Add and validate a trigger before enabling it.",
      );
      await refresh();
    } catch (error) {
      setMessage(mutationMessage(error, "Could not create agent."));
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    setMessage(null);
    try {
      const saved = (await saveAgent.mutateAsync({
        agentId: detail.agentId,
        expectedRevision: detail.currentRevision,
        draft: toDraft(draftForm),
      })) as AgentDefinition;
      setMessage(
        `Saved revision ${saved.currentRevision}. Existing triggers remain pinned to their prior revision.`,
      );
      await refresh();
    } catch (error) {
      setMessage(mutationMessage(error, "Could not save revision."));
    }
  }

  async function handleCreateTrigger(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    setMessage(null);
    try {
      if (triggerKind === "github") {
        const invalidConditionIndex = githubConditions.findIndex(
          (condition) =>
            condition.field !== "draft_state" &&
            condition.values.some((value) => value.trim().length === 0),
        );
        if (invalidConditionIndex >= 0) {
          setMessage(
            `Condition ${invalidConditionIndex + 1} has a blank value. Enter a value or remove it.`,
          );
          return;
        }
        const choice =
          GITHUB_TRIGGER_CHOICES.find((item) => item.id === githubChoiceId) ??
          GITHUB_TRIGGER_CHOICES[0];
        const config = {
          event: choice.event,
          actions: [choice.action],
          conditions: githubConditions.map(toGithubTriggerConditionInput),
        };
        if (replacementTriggerId) {
          await replaceTrigger.mutateAsync({
            agentId: detail.agentId,
            expectedRevision: detail.currentRevision,
            triggerId: replacementTriggerId,
            kind: "github",
            config,
          });
          setReplacementTriggerId(null);
          setGithubConditions([]);
          setMessage("Trigger replaced atomically on the current revision.");
        } else {
          await createTrigger.mutateAsync({
            agentId: detail.agentId,
            expectedRevision: detail.currentRevision,
            kind: "github",
            config,
          });
          setMessage(
            "Validated trigger added and pinned to the current revision.",
          );
          setGithubConditions([]);
        }
      } else {
        await createTrigger.mutateAsync({
          agentId: detail.agentId,
          expectedRevision: detail.currentRevision,
          kind: "schedule",
          config: {
            schedule,
            timezone,
            target: {
              kind: triggerTargetKind,
              number: Number(triggerTargetNumber),
            },
          },
        });
        setMessage(
          "Validated trigger added and pinned to the current revision.",
        );
      }
      await refresh();
    } catch (error) {
      setMessage(mutationMessage(error, "Could not create trigger."));
    }
  }

  async function handleRemoveTrigger() {
    if (!detail || !triggerToRemove) return;
    setMessage(null);
    try {
      await removeTrigger.mutateAsync({
        agentId: detail.agentId,
        expectedRevision: detail.currentRevision,
        triggerId: triggerToRemove.triggerId,
      });
      setTriggerToRemove(null);
      setMessage("Trigger removed. Historical run evidence remains intact.");
      await refresh();
    } catch (error) {
      setTriggerToRemove(null);
      setMessage(mutationMessage(error, "Could not remove trigger."));
    }
  }

  function prepareReplacement(trigger: AgentTriggerView) {
    if (trigger.kind !== "github") return;
    setTriggerKind("github");
    setGithubChoiceId(trigger.choiceId ?? "issue_created");
    setGithubConditions(
      "event" in trigger.config
        ? structuredClone(trigger.config.conditions ?? [])
        : [],
    );
    setReplacementTriggerId(trigger.triggerId);
    document.getElementById("trigger-editor")?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }

  function changeGithubChoice(nextId: GithubTriggerChoiceId) {
    const choice =
      GITHUB_TRIGGER_CHOICES.find((item) => item.id === nextId) ??
      GITHUB_TRIGGER_CHOICES[0];
    const applicable = githubConditions.filter((condition) =>
      conditionAllowedForEvent(condition.field, choice.event),
    );
    if (applicable.length !== githubConditions.length) {
      setMessage(
        "Pull request-only conditions were removed because the selected issue event cannot provide them.",
      );
    }
    setGithubChoiceId(nextId);
    setGithubConditions(applicable);
  }

  function cancelTriggerReplacement() {
    setReplacementTriggerId(null);
    setGithubConditions([]);
  }

  async function handleCopyDefinition() {
    if (!detail) return;
    setMessage(null);
    try {
      const result = await exportQuery.refetch();
      const document = result.data as AgentDefinitionExport | undefined;
      if (!document) throw new Error("Agent definition is unavailable.");
      await navigator.clipboard.writeText(JSON.stringify(document, null, 2));
      setMessage("Current agent definition copied as versioned JSON.");
    } catch (error) {
      setMessage(mutationMessage(error, "Could not copy agent JSON."));
    }
  }

  async function handleQueueTestRun() {
    if (!detail) return;
    setMessage(null);
    try {
      const queued = (await queueTestRun.mutateAsync({
        agentId: detail.agentId,
        expectedRevision: detail.currentRevision,
        target: { kind: testTargetKind, number: Number(testTargetNumber) },
      })) as { execution: { executionId: string; agentRevision: number } };
      setMessage(
        `Dry-run test ${queued.execution.executionId.slice(0, 10)} queued against revision ${queued.execution.agentRevision}. No worker or publish action starts here.`,
      );
      await refresh();
    } catch (error) {
      setMessage(mutationMessage(error, "Could not queue test run."));
    }
  }

  async function handleSchedulePause(trigger: AgentTrigger) {
    setMessage(null);
    try {
      await setSchedulePaused.mutateAsync({
        triggerId: trigger.triggerId,
        paused: !trigger.pausedAt,
      });
      setMessage(
        trigger.pausedAt
          ? "Schedule trigger resumed."
          : "Schedule trigger paused.",
      );
      await refresh();
    } catch (error) {
      setMessage(mutationMessage(error, "Could not change trigger state."));
    }
  }

  async function confirmLifecycle() {
    if (!detail || !confirmation) return;
    setMessage(null);
    try {
      if (confirmation === "stop") {
        await stopAgent.mutateAsync({
          agentId: detail.agentId,
          expectedRevision: detail.currentRevision,
        });
        setMessage(
          "Emergency stop recorded. The agent is disabled; in-flight work was canceled only if its policy permits it.",
        );
      } else {
        await setEnabled.mutateAsync({
          agentId: detail.agentId,
          expectedRevision: detail.currentRevision,
          enabled: confirmation === "enable",
        });
        setMessage(
          confirmation === "enable"
            ? "Agent enabled after trigger validation."
            : "Agent disabled. Future trigger deliveries will not enqueue work.",
        );
      }
      setConfirmation(null);
      await refresh();
    } catch (error) {
      setMessage(mutationMessage(error, "Could not update agent state."));
      setConfirmation(null);
    }
  }

  const confirmationCopy =
    confirmation === "enable"
      ? {
          title: "Enable this agent?",
          body: "Enabled triggers may queue dry-run work using their pinned revision. Publishing remains governed by this agent's policy.",
          confirm: "Enable agent",
        }
      : confirmation === "disable"
        ? {
            title: "Disable this agent?",
            body: "Future trigger deliveries stop immediately. Existing queued work remains visible and is not deleted.",
            confirm: "Disable agent",
          }
        : {
            title: "Emergency stop this agent?",
            body: "This disables the agent and records an audit event. Lease-held work is canceled only when the saved policy allows it.",
            confirm: "Emergency stop",
          };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 lg:px-8 lg:py-10">
      <header className="grid gap-4 border-b border-border pb-6 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="max-w-3xl">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <IconShieldCheck className="size-4" />
            Control plane preview
          </div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Agents
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
            Create disabled drafts, validate a trigger, then explicitly enable a
            revision-pinned dry-run agent. No cloud resource, scheduler, worker,
            or publish action starts from this console.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setCreateOpen(true)}
        >
          <IconPlus className="size-4" />
          New agent
        </Button>
      </header>

      {message ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/35 px-3 py-2 text-sm">
          <IconCircle className="mt-1 size-2 shrink-0 fill-primary text-primary" />
          <p>{message}</p>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Agent directory</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Safe metadata and seven-day KPIs.
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              type="button"
              onClick={() => void refresh()}
              aria-label="Refresh agents"
            >
              <IconRefresh className="size-4" />
            </Button>
          </div>
          <div className="relative">
            <IconSearch className="pointer-events-none absolute start-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="Search agents"
              className="ps-9"
              value={filter.query}
              onChange={(event) =>
                setFilter((current) => ({
                  ...current,
                  query: event.target.value,
                }))
              }
              placeholder="Search agents"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select
              aria-label="Filter enabled state"
              value={filter.enabled}
              onChange={(event) =>
                setFilter((current) => ({
                  ...current,
                  enabled: event.target.value as AgentListFilter["enabled"],
                }))
              }
              className="flex h-9 rounded-md border border-input bg-transparent px-2 text-xs"
            >
              <option value="all">All states</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
            </select>
            <select
              aria-label="Filter health"
              value={filter.health}
              onChange={(event) =>
                setFilter((current) => ({
                  ...current,
                  health: event.target.value as AgentListFilter["health"],
                }))
              }
              className="flex h-9 rounded-md border border-input bg-transparent px-2 text-xs"
            >
              <option value="all">All health</option>
              <option value="idle">Idle</option>
              <option value="queued">Queued</option>
              <option value="running">Running</option>
              <option value="paused">Paused</option>
              <option value="failed">Failed</option>
            </select>
          </div>
          <ul className="max-h-[calc(100vh-22rem)] space-y-2 overflow-auto">
            {listQuery.isLoading ? (
              <li className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                Loading agents…
              </li>
            ) : agents.length === 0 ? (
              <li className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                No agents match this view.
              </li>
            ) : (
              agents.map((agent) => (
                <li key={agent.agentId}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(agent.agentId)}
                    className={`w-full rounded-md border p-3 text-left transition ${selectedId === agent.agentId ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"}`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {agent.name}
                      </span>
                      <span
                        className={`size-2 shrink-0 rounded-full ${stateTone(agent.enabled ? agent.health.state : "paused")}`}
                        aria-label={
                          agent.enabled ? agent.health.state : "disabled"
                        }
                      />
                    </span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">
                      {agent.repository}
                    </span>
                    <span className="mt-2 grid grid-cols-3 gap-1 text-[11px] text-muted-foreground">
                      <span>{agent.enabled ? "Enabled" : "Disabled"}</span>
                      <span>{agent.runsLastSevenDays} 7d</span>
                      <span>{percent(agent.successRate)} pass</span>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </aside>

        {detail ? (
          <div className="min-w-0 space-y-6">
            <section className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-[1fr_auto] sm:items-start">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold">{detail.name}</h2>
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium">
                    r{detail.currentRevision}
                  </span>
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs">
                    {detail.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {detail.repository}
                  {detail.branch ? ` · ${detail.branch}` : ""} ·{" "}
                  {policyLabel(detail.publicationPolicy)}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Last audit:{" "}
                  {detail.lastAuditEvent
                    ? `${detail.lastAuditEvent.action.replace(/_/g, " ")} · ${formatTime(detail.lastAuditEvent.occurredAt)}`
                    : "No events"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy || exportQuery.isFetching}
                  onClick={() => void handleCopyDefinition()}
                >
                  <IconCopy className="size-4" /> Copy as JSON
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={handleQueueTestRun}
                >
                  <IconBolt className="size-4" /> Test run
                </Button>
                <Button
                  type="button"
                  variant={detail.enabled ? "outline" : "default"}
                  disabled={busy}
                  onClick={() =>
                    setConfirmation(detail.enabled ? "disable" : "enable")
                  }
                >
                  {detail.enabled ? (
                    <IconPlayerPause className="size-4" />
                  ) : (
                    <IconPlayerPlay className="size-4" />
                  )}
                  {detail.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setConfirmation("stop")}
                >
                  <IconPlayerStop className="size-4" /> Stop
                </Button>
              </div>
            </section>

            <section className="grid gap-3 sm:grid-cols-4">
              <Metric label="Queued" value={detail.queuedRuns.toString()} />
              <Metric label="Active" value={detail.activeRuns.toString()} />
              <Metric
                label="7-day runs"
                value={detail.runsLastSevenDays.toString()}
              />
              <Metric
                label="Success rate"
                value={percent(detail.successRate)}
              />
            </section>

            <form
              onSubmit={handleSave}
              className="space-y-4 rounded-lg border border-border p-4"
            >
              <div>
                <h3 className="text-base font-semibold">Configuration</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Save creates a new revision. Secret-like values are rejected
                  before persistence.
                </p>
              </div>
              <DraftFields
                form={draftForm}
                onChange={setDraftForm}
                disabled={busy}
                repositoryCatalog={repositoryCatalog}
                repositoryQuery={draftRepositoryQuery}
                onRepositoryQueryChange={setDraftRepositoryQuery}
                originalRepository={detail.repository}
                onRefreshRepositories={() => void repositoryQuery.refetch()}
              />
              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    !canSaveRepositorySelection(
                      repositoryCatalog,
                      detail.repository,
                      draftForm.repository,
                    )
                  }
                >
                  Save revision
                </Button>
              </div>
            </form>

            <section className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-4 rounded-lg border border-border p-4">
                <div>
                  <h3 className="text-base font-semibold">Triggers</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Each trigger stays pinned to the revision that created it.
                  </p>
                </div>
                <ul className="space-y-2">
                  {detail.triggers.length === 0 ? (
                    <li className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                      Add a validated trigger before enabling.
                    </li>
                  ) : (
                    detail.triggers.map((trigger) => (
                      <TriggerRow
                        key={trigger.triggerId}
                        trigger={trigger}
                        busy={busy}
                        onPause={() => void handleSchedulePause(trigger)}
                        onReplace={() => prepareReplacement(trigger)}
                        onRemove={() => setTriggerToRemove(trigger)}
                      />
                    ))
                  )}
                </ul>
                <form
                  id="trigger-editor"
                  onSubmit={handleCreateTrigger}
                  className="space-y-3 border-t border-border pt-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="trigger-kind">Add trigger</Label>
                    <select
                      id="trigger-kind"
                      value={triggerKind}
                      onChange={(event) => {
                        const next = event.target.value as
                          | "github"
                          | "schedule";
                        setTriggerKind(next);
                        if (next === "schedule") {
                          setReplacementTriggerId(null);
                          setGithubConditions([]);
                        }
                      }}
                      className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                    >
                      <option value="github">GitHub event</option>
                      <option value="schedule">Schedule</option>
                    </select>
                  </div>
                  {triggerKind === "github" ? (
                    <div className="grid gap-3">
                      <Field label="GitHub activity">
                        <select
                          value={githubChoiceId}
                          onChange={(event) =>
                            changeGithubChoice(
                              event.target.value as GithubTriggerChoiceId,
                            )
                          }
                          className="input-shell"
                        >
                          {GITHUB_TRIGGER_CHOICES.map((choice) => (
                            <option key={choice.id} value={choice.id}>
                              {choice.label}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <GithubConditionEditor
                        event={
                          GITHUB_TRIGGER_CHOICES.find(
                            (choice) => choice.id === githubChoiceId,
                          )?.event ?? "issues"
                        }
                        conditions={githubConditions}
                        onChange={setGithubConditions}
                        disabled={busy}
                      />
                    </div>
                  ) : (
                    <div className="grid gap-3">
                      <Field label="Cron schedule">
                        <Input
                          value={schedule}
                          onChange={(event) => setSchedule(event.target.value)}
                          required
                        />
                      </Field>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <Field label="IANA timezone">
                          <Input
                            value={timezone}
                            onChange={(event) =>
                              setTimezone(event.target.value)
                            }
                            required
                          />
                        </Field>
                        <Field label="Target type">
                          <select
                            value={triggerTargetKind}
                            onChange={(event) =>
                              setTriggerTargetKind(
                                event.target.value as "issue" | "pull",
                              )
                            }
                            className="input-shell"
                          >
                            <option value="issue">Issue</option>
                            <option value="pull">Pull request</option>
                          </select>
                        </Field>
                        <Field label="Target number">
                          <Input
                            type="number"
                            min={1}
                            value={triggerTargetNumber}
                            onChange={(event) =>
                              setTriggerTargetNumber(event.target.value)
                            }
                            required
                          />
                        </Field>
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="submit" variant="outline" disabled={busy}>
                      {replacementTriggerId
                        ? "Replace trigger"
                        : "Validate and add trigger"}
                    </Button>
                    {replacementTriggerId ? (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={cancelTriggerReplacement}
                      >
                        Cancel replacement
                      </Button>
                    ) : null}
                  </div>
                </form>
              </div>

              <div className="space-y-4 rounded-lg border border-border p-4">
                <div>
                  <h3 className="text-base font-semibold">
                    Run history and evidence
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Queue entries are revision-pinned. Receipts are redacted
                    before display.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Test target type">
                    <select
                      value={testTargetKind}
                      onChange={(event) =>
                        setTestTargetKind(
                          event.target.value as "issue" | "pull",
                        )
                      }
                      className="input-shell"
                    >
                      <option value="issue">Issue</option>
                      <option value="pull">Pull request</option>
                    </select>
                  </Field>
                  <Field label="Test target number">
                    <Input
                      type="number"
                      min={1}
                      value={testTargetNumber}
                      onChange={(event) =>
                        setTestTargetNumber(event.target.value)
                      }
                    />
                  </Field>
                </div>
                <ul className="space-y-2">
                  {detail.runHistory.length === 0 ? (
                    <li className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                      No queued runs.
                    </li>
                  ) : (
                    detail.runHistory.map((run) => (
                      <li
                        key={run.executionId}
                        className="rounded-md border border-border px-3 py-2"
                      >
                        <div className="flex justify-between gap-2 text-sm">
                          <span className="font-medium">
                            {run.state.replace(/_/g, " ")}
                          </span>
                          <span className="text-muted-foreground">
                            r{run.revision}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {run.source} · {run.target} ·{" "}
                          {formatTime(run.updatedAt)}
                        </p>
                      </li>
                    ))
                  )}
                </ul>
                {detail.evidence.length > 0 ? (
                  <ul className="space-y-2 border-t border-border pt-3">
                    {detail.evidence.map((item) => (
                      <li key={item.runId} className="text-sm">
                        <div className="flex justify-between gap-2">
                          <span className="font-medium">{item.status}</span>
                          <span className="text-muted-foreground">
                            {formatTime(item.updatedAt)}
                          </span>
                        </div>
                        <p className="mt-1 break-words text-xs text-muted-foreground">
                          {item.summary ??
                            item.verification?.command ??
                            "No receipt summary"}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </section>

            <section className="rounded-lg border border-border p-4">
              <h3 className="text-base font-semibold">Audit</h3>
              <ol className="mt-3 grid gap-2 sm:grid-cols-2">
                {detail.audit.length === 0 ? (
                  <li className="text-sm text-muted-foreground">
                    No audit events.
                  </li>
                ) : (
                  detail.audit.map((event) => (
                    <li
                      key={event.eventId}
                      className="flex gap-2 rounded-md bg-muted/45 px-3 py-2 text-sm"
                    >
                      <IconClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span>
                        <span className="font-medium">
                          {event.action.replace(/_/g, " ")}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          r{event.revision} · {formatTime(event.occurredAt)}
                        </span>
                      </span>
                    </li>
                  ))
                )}
              </ol>
            </section>
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              Select an agent or create a disabled draft.
            </CardContent>
          </Card>
        )}
      </div>

      <Sheet open={createOpen} onOpenChange={setCreateOpen}>
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>New agent</SheetTitle>
            <SheetDescription>
              Create a disabled draft. Nothing executes until a trigger is
              validated and you explicitly enable it.
            </SheetDescription>
          </SheetHeader>
          <form onSubmit={handleCreate} className="mt-6 space-y-4">
            <DraftFields
              form={createForm}
              onChange={setCreateForm}
              disabled={busy}
              repositoryCatalog={repositoryCatalog}
              repositoryQuery={createRepositoryQuery}
              onRepositoryQueryChange={setCreateRepositoryQuery}
              originalRepository=""
              onRefreshRepositories={() => void repositoryQuery.refetch()}
            />
            <SheetFooter className="mt-6">
              <Button
                type="submit"
                disabled={
                  busy ||
                  !canSaveRepositorySelection(
                    repositoryCatalog,
                    "",
                    createForm.repository,
                  )
                }
              >
                <IconPlus className="size-4" />
                Create disabled draft
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      <Sheet
        open={confirmation !== null}
        onOpenChange={(open) => !open && setConfirmation(null)}
      >
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{confirmationCopy.title}</SheetTitle>
            <SheetDescription>{confirmationCopy.body}</SheetDescription>
          </SheetHeader>
          <div className="mt-6 flex gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
            This control is recorded in the agent audit history.
          </div>
          <SheetFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={confirmation === "stop" ? "destructive" : "default"}
              disabled={busy}
              onClick={() => void confirmLifecycle()}
            >
              {confirmationCopy.confirm}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Sheet
        open={triggerToRemove !== null}
        onOpenChange={(open) => !open && setTriggerToRemove(null)}
      >
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Remove this trigger?</SheetTitle>
            <SheetDescription>
              {triggerToRemove?.label}. New deliveries will stop matching this
              trigger; historical run evidence remains intact.
            </SheetDescription>
          </SheetHeader>
          <SheetFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => setTriggerToRemove(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void handleRemoveTrigger()}
            >
              Remove trigger
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 text-lg font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}

function GithubConditionEditor({
  event,
  conditions,
  onChange,
  disabled,
}: {
  event: "issues" | "pull_request";
  conditions: GithubConditionDraft[];
  onChange: (conditions: GithubConditionDraft[]) => void;
  disabled: boolean;
}) {
  const availableFields = GITHUB_TRIGGER_CONDITION_CATALOG.filter((item) =>
    (item.events as readonly string[]).includes(event),
  );
  const replaceCondition = (index: number, condition: GithubConditionDraft) =>
    onChange(
      conditions.map((item, itemIndex) =>
        itemIndex === index ? condition : item,
      ),
    );

  return (
    <div className="grid gap-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Conditions (optional)</p>
          <p className="mt-1 text-xs text-muted-foreground">
            All conditions must match. Actor and label comparisons ignore case;
            branch names are exact.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={
            disabled ||
            conditions.length >= GITHUB_TRIGGER_CONDITION_LIMITS.rows
          }
          onClick={() =>
            onChange([
              ...conditions,
              createGithubConditionDraft(availableFields[0]!.field),
            ])
          }
        >
          <IconPlus className="size-3.5" /> Add condition
        </Button>
      </div>

      {conditions.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          No conditions. Every otherwise eligible{" "}
          {event === "issues" ? "issue" : "pull request"} event matches.
        </p>
      ) : (
        <ol className="grid gap-3">
          {conditions.map((condition, conditionIndex) => {
            const definition = GITHUB_TRIGGER_CONDITION_CATALOG.find(
              (item) => item.field === condition.field,
            )!;
            return (
              <li
                key={`${conditionIndex}-${condition.field}`}
                className="grid gap-3 rounded-md border border-border bg-background p-3"
              >
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <Field label="Field">
                    <select
                      aria-label={`Condition ${conditionIndex + 1} field`}
                      value={condition.field}
                      disabled={disabled}
                      onChange={(changeEvent) =>
                        replaceCondition(
                          conditionIndex,
                          createGithubConditionDraft(
                            changeEvent.target
                              .value as GithubTriggerConditionField,
                          ),
                        )
                      }
                      className="input-shell"
                    >
                      {availableFields.map((item) => (
                        <option key={item.field} value={item.field}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Operator">
                    <select
                      aria-label={`Condition ${conditionIndex + 1} operator`}
                      value={condition.operator}
                      disabled={disabled}
                      onChange={(changeEvent) =>
                        replaceCondition(conditionIndex, {
                          ...condition,
                          operator: changeEvent.target.value,
                        } as GithubConditionDraft)
                      }
                      className="input-shell"
                    >
                      {definition.operators.map((operator) => (
                        <option key={operator.id} value={operator.id}>
                          {operator.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() =>
                      onChange(
                        conditions.filter(
                          (_, itemIndex) => itemIndex !== conditionIndex,
                        ),
                      )
                    }
                    aria-label={`Remove condition ${conditionIndex + 1}`}
                  >
                    <IconTrash className="size-4" />
                  </Button>
                </div>

                {condition.field !== "draft_state" ? (
                  <div className="grid gap-2">
                    <div className="flex items-center justify-between gap-2 text-xs font-medium">
                      <span>Values</span>
                      <span className="font-normal text-muted-foreground">
                        {condition.values.length}/
                        {GITHUB_TRIGGER_CONDITION_LIMITS.values}
                      </span>
                    </div>
                    {condition.values.map((value, valueIndex) => (
                      <div
                        key={valueIndex}
                        className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
                      >
                        <Input
                          aria-label={`Condition ${conditionIndex + 1} value ${valueIndex + 1}`}
                          value={value}
                          maxLength={
                            GITHUB_TRIGGER_CONDITION_LIMITS.valueLength
                          }
                          disabled={disabled}
                          placeholder={
                            condition.field === "actor"
                              ? "octocat"
                              : condition.field === "labels"
                                ? "ready-for-agent"
                                : "main"
                          }
                          onChange={(changeEvent) => {
                            const values = condition.values.map(
                              (item, itemIndex) =>
                                itemIndex === valueIndex
                                  ? changeEvent.target.value
                                  : item,
                            );
                            replaceCondition(conditionIndex, {
                              ...condition,
                              values,
                            });
                          }}
                          required
                        />
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          disabled={disabled || condition.values.length === 1}
                          onClick={() =>
                            replaceCondition(conditionIndex, {
                              ...condition,
                              values: condition.values.filter(
                                (_, itemIndex) => itemIndex !== valueIndex,
                              ),
                            })
                          }
                          aria-label={`Remove condition ${conditionIndex + 1} value ${valueIndex + 1}`}
                        >
                          <IconTrash className="size-4" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="justify-self-start"
                      disabled={
                        disabled ||
                        condition.values.length >=
                          GITHUB_TRIGGER_CONDITION_LIMITS.values
                      }
                      onClick={() =>
                        replaceCondition(conditionIndex, {
                          ...condition,
                          values: [...condition.values, ""],
                        })
                      }
                    >
                      <IconPlus className="size-3.5" /> Add value
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      <p className="text-xs text-muted-foreground">
        Up to {GITHUB_TRIGGER_CONDITION_LIMITS.rows} conditions; membership
        conditions accept {GITHUB_TRIGGER_CONDITION_LIMITS.values} values of up
        to {GITHUB_TRIGGER_CONDITION_LIMITS.valueLength} characters each.
      </p>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      <span>{label}</span>
      {children}
    </label>
  );
}

function DraftFields({
  form,
  onChange,
  disabled,
  repositoryCatalog,
  repositoryQuery,
  onRepositoryQueryChange,
  originalRepository,
  onRefreshRepositories,
}: {
  form: DraftForm;
  onChange: (next: DraftForm) => void;
  disabled: boolean;
  repositoryCatalog: AgentRepositoryCatalogResult | undefined;
  repositoryQuery: string;
  onRepositoryQueryChange: (next: string) => void;
  originalRepository: string;
  onRefreshRepositories: () => void;
}) {
  const update = <Key extends keyof DraftForm>(
    key: Key,
    value: DraftForm[Key],
  ) => onChange({ ...form, [key]: value });
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input
            value={form.name}
            disabled={disabled}
            onChange={(event) => update("name", event.target.value)}
            required
          />
        </Field>
        <Field label="Action preset">
          <select
            value={form.actionPreset}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                applyActionPresetChange(
                  form,
                  event.target.value as ActionPreset,
                ),
              )
            }
            className="input-shell"
          >
            {ACTION_PRESET_CHOICES.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Skill ID">
        <Input
          value={form.skillId}
          disabled={disabled}
          onChange={(event) => update("skillId", event.target.value)}
          placeholder={
            form.actionPreset === "fix_issue"
              ? "Leave empty for issue mode"
              : "fix-review-findings"
          }
          required={form.actionPreset === "resolve_pr_feedback"}
        />
      </Field>
      <Field label="Instructions">
        <textarea
          value={form.instructions}
          disabled={disabled}
          onChange={(event) => update("instructions", event.target.value)}
          required
          rows={5}
          className="min-h-28 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <RepositoryPicker
          catalog={repositoryCatalog}
          query={repositoryQuery}
          onQueryChange={onRepositoryQueryChange}
          value={form.repository}
          originalRepository={originalRepository}
          disabled={disabled}
          onRefresh={onRefreshRepositories}
          onSelect={(option) =>
            onChange({
              ...form,
              repository: option.repository,
              branch: option.defaultBranch || form.branch,
            })
          }
        />
        <Field label="Branch scope">
          <Input
            value={form.branch}
            disabled={disabled}
            onChange={(event) => update("branch", event.target.value)}
            placeholder="main"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Allowed tools">
          <Input
            value={form.allowedTools}
            disabled={disabled}
            onChange={(event) => update("allowedTools", event.target.value)}
            placeholder="github, terminal"
            required
          />
        </Field>
        <Field label="Verification preset">
          <Input
            value={form.presetId}
            disabled={disabled}
            onChange={(event) => update("presetId", event.target.value)}
            required
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Publication policy">
          <select
            value={form.publicationPolicy}
            disabled={disabled}
            onChange={(event) =>
              update(
                "publicationPolicy",
                event.target.value as DraftForm["publicationPolicy"],
              )
            }
            className="input-shell"
          >
            <option value="dry_run">Dry run only</option>
            <option value="approval_required">Approval required</option>
            <option value="publish_allowed">Publish allowed</option>
          </select>
        </Field>
        <Field label="Failure threshold">
          <Input
            type="number"
            min={1}
            max={100}
            value={form.failureThreshold}
            disabled={disabled}
            onChange={(event) => update("failureThreshold", event.target.value)}
            placeholder="Optional"
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.cancelInFlight}
          disabled={disabled}
          onChange={(event) => update("cancelInFlight", event.target.checked)}
        />
        Cancel lease-held work on emergency stop
      </label>
    </div>
  );
}

function RepositoryPicker({
  catalog,
  query,
  onQueryChange,
  value,
  originalRepository,
  disabled,
  onRefresh,
  onSelect,
}: {
  catalog: AgentRepositoryCatalogResult | undefined;
  query: string;
  onQueryChange: (next: string) => void;
  value: string;
  originalRepository: string;
  disabled: boolean;
  onRefresh: () => void;
  onSelect: (option: RepositoryPickerOption) => void;
}) {
  const view = buildRepositoryPickerView(catalog, query, originalRepository);
  const selectedAvailable = canSaveRepositorySelection(
    catalog,
    originalRepository,
    value,
  );
  return (
    <div className="grid gap-1.5 text-sm font-medium sm:col-span-2">
      <div className="flex items-center justify-between gap-3">
        <span>Repository scope</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={onRefresh}
        >
          <IconRefresh className="size-4" /> Refresh
        </Button>
      </div>
      <div className="overflow-hidden rounded-md border border-input bg-background">
        <div className="relative border-b border-border">
          <IconSearch className="pointer-events-none absolute start-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search available repositories"
            className="border-0 ps-9 shadow-none focus-visible:ring-0"
            value={query}
            disabled={disabled}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search available repositories"
          />
        </div>
        <div
          role="listbox"
          aria-label="Available repositories"
          className="max-h-40 overflow-y-auto p-1"
        >
          {view.options.map((option) => (
            <button
              key={option.repository}
              type="button"
              role="option"
              aria-selected={option.repository === value}
              disabled={disabled || !option.selectable}
              onClick={() => onSelect(option)}
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm transition-[color,background-color] disabled:cursor-not-allowed disabled:opacity-55 ${option.repository === value ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            >
              {option.archived ? (
                <IconArchive className="size-4 shrink-0" />
              ) : (
                <IconBrandGithub className="size-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {option.repository}
              </span>
              {option.repository === value ? (
                <IconCheck className="size-4 shrink-0" />
              ) : option.unavailable ? (
                <span className="text-[11px]">Unavailable</span>
              ) : null}
            </button>
          ))}
          {view.state === "loading" ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              Loading repositories…
            </p>
          ) : view.state === "empty" ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No repositories match this search.
            </p>
          ) : null}
        </div>
      </div>
      {view.state === "error" ? (
        <p className="flex items-start gap-1.5 text-xs font-normal text-destructive">
          <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {view.message} An unchanged repository scope remains savable, but new
          selections are blocked.
        </p>
      ) : !selectedAvailable && value ? (
        <p className="text-xs font-normal text-destructive">
          Select an available repository before saving.
        </p>
      ) : null}
    </div>
  );
}

function TriggerRow({
  trigger,
  busy,
  onPause,
  onReplace,
  onRemove,
}: {
  trigger: AgentTriggerView;
  busy: boolean;
  onPause: () => void;
  onReplace: () => void;
  onRemove: () => void;
}) {
  const scheduleTrigger =
    trigger.kind === "schedule" && "schedule" in trigger.config;
  return (
    <li className="rounded-md border border-border px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{trigger.label}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Revision {trigger.agentRevision}
            {scheduleTrigger ? ` · next ${formatTime(trigger.nextFireAt)}` : ""}
            {trigger.pausedAt ? " · paused" : ""}
          </p>
          {trigger.legacy ? (
            <p className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
              <IconAlertTriangle className="size-3.5" /> Legacy trigger; replace
              it with a supported activity.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {scheduleTrigger ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onPause}
            >
              {trigger.pausedAt ? "Resume" : "Pause"}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={onReplace}
            >
              <IconArrowsExchange className="size-4" /> Replace
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={busy}
            onClick={onRemove}
            aria-label={`Remove ${trigger.label}`}
          >
            <IconTrash className="size-4" />
          </Button>
        </div>
      </div>
    </li>
  );
}
