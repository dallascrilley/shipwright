import type {
  ReviewFixGroup,
  ReviewOwnershipAuthorization,
  ReviewScope,
} from "../pipeline/repair-candidate.js";
export type ReviewDeliveryMode = "patch" | "commit" | "follow-up-pr" | "evidence-only";

export interface ReviewCliArgs {
  pullRequestUrl: string;
  verifyCommand: string;
  skillPath: string;
  publish: boolean;
  deliveryMode?: ReviewDeliveryMode;
  candidateId?: string;
  ownership?: ReviewOwnershipAuthorization;
  reviewScope?: ReviewScope;
  fixGroups?: ReviewFixGroup[];
  timeoutMinutes: number;
}

const USAGE =
  "Usage: bun run review-agent -- <pull-request-url> --verify <command> --skill <SKILL.md> [--publish] [--candidate-id <id>] [--finding-id <id> ...] [--review-id <id>|--review-head-sha <sha>] [--fix-group <group-id=finding-id,...> ...] [--delivery-mode patch|commit|follow-up-pr|evidence-only] [--owner-id <owner>] [--handoff-from-owner <owner>] [--handoff-id <id>] [--authorized-by <actor>] [--timeout-minutes <1-120>]";

function parseSafeId(value: string | undefined, label: string, maxLength = 160): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(trimmed)) {
    throw new Error(`invalid ${label}: ${value ?? "(missing)"}`);
  }
  return trimmed;
}

function parseFixGroups(values: string[], findingIds: readonly string[]): ReviewFixGroup[] | undefined {
  if (values.length === 0) return undefined;
  if (findingIds.length === 0) throw new Error("--fix-group requires at least one --finding-id");
  const groups: ReviewFixGroup[] = [];
  const groupIds = new Set<string>();
  const assigned = new Set<string>();
  for (const value of values) {
    const separator = value.indexOf("=");
    const groupId = parseSafeId(separator < 0 ? undefined : value.slice(0, separator), "fix group id");
    if (groupIds.has(groupId)) throw new Error(`duplicate fix group id: ${groupId}`);
    const ids = (separator < 0 ? "" : value.slice(separator + 1))
      .split(",")
      .map((findingId) => findingId.trim())
      .filter(Boolean)
      .map((findingId) => parseSafeId(findingId, "fix group finding id"));
    if (ids.length === 0) throw new Error(`fix group ${groupId} must contain finding IDs`);
    for (const findingId of ids) {
      if (assigned.has(findingId)) throw new Error(`finding belongs to multiple fix groups: ${findingId}`);
      assigned.add(findingId);
    }
    groupIds.add(groupId);
    groups.push({ groupId, findingIds: ids });
  }
  return groups;
}

export function parseReviewArgs(argv: string[]): ReviewCliArgs {
  const pullRequestUrl = argv[0];
  if (!pullRequestUrl || pullRequestUrl.startsWith("--")) throw new Error(USAGE);
  let verifyCommand: string | undefined;
  let skillPath: string | undefined;
  let publish = false;
  let deliveryMode: ReviewDeliveryMode | undefined;
  let candidateId: string | undefined;
  let ownerId: string | undefined;
  let handoffFromOwnerId: string | undefined;
  let handoffId: string | undefined;
  let authorizedBy: string | undefined;
  let reviewId: string | undefined;
  let reviewHeadSha: string | undefined;
  const findingIds: string[] = [];
  const fixGroupValues: string[] = [];
  let timeoutMinutes = 30;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--publish") publish = true;
    else if (arg === "--delivery-mode") {
      const value = argv[++index];
      if (value !== "patch" && value !== "commit" && value !== "follow-up-pr" && value !== "evidence-only") {
        throw new Error(`invalid delivery mode: ${value ?? "(missing)"}`);
      }
      deliveryMode = value;
    } else if (arg === "--candidate-id") {
      candidateId = parseSafeId(argv[++index], "candidate id");
    } else if (arg === "--finding-id") {
      findingIds.push(parseSafeId(argv[++index], "finding id"));
    } else if (arg === "--review-id") {
      reviewId = parseSafeId(argv[++index], "review id");
    } else if (arg === "--review-head-sha") {
      const value = argv[++index]?.trim();
      if (!value || !/^[0-9a-f]{40}$/.test(value)) throw new Error(`invalid review head SHA: ${value ?? "(missing)"}`);
      reviewHeadSha = value;
    } else if (arg === "--fix-group") {
      const value = argv[++index]?.trim();
      if (!value) throw new Error("invalid fix group: (missing)");
      fixGroupValues.push(value);
    } else if (arg === "--owner-id") {
      const value = argv[++index]?.trim();
      if (!value || value.length > 160) throw new Error(`invalid owner id: ${value ?? "(missing)"}`);
      ownerId = value;
    } else if (arg === "--handoff-from-owner") {
      const value = argv[++index]?.trim();
      if (!value || value.length > 160) throw new Error(`invalid handoff source owner: ${value ?? "(missing)"}`);
      handoffFromOwnerId = value;
    } else if (arg === "--handoff-id") {
      const value = argv[++index]?.trim();
      if (!value || value.length > 256) throw new Error(`invalid handoff id: ${value ?? "(missing)"}`);
      handoffId = value;
    } else if (arg === "--authorized-by") {
      const value = argv[++index]?.trim();
      if (!value || value.length > 160) throw new Error(`invalid authorizer: ${value ?? "(missing)"}`);
      authorizedBy = value;
    } else if (arg === "--timeout-minutes") {
      const value = argv[++index];
      if (!value || !/^\d+$/.test(value)) {
        throw new Error(`invalid timeout: ${value ?? "(missing)"}`);
      }
      timeoutMinutes = Number(value);
    } else if (arg === "--verify") verifyCommand = argv[++index];
    else if (arg === "--skill") skillPath = argv[++index];
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  if (!verifyCommand?.trim()) throw new Error(`--verify is required\n${USAGE}`);
  if (!skillPath?.trim()) throw new Error(`--skill is required\n${USAGE}`);
  if (findingIds.length > 0 && reviewId && reviewHeadSha) {
    throw new Error("--review-id and --review-head-sha are mutually exclusive");
  }
  if ((reviewId || reviewHeadSha) && findingIds.length === 0) {
    throw new Error("--review-id or --review-head-sha requires at least one --finding-id");
  }
  if (fixGroupValues.length > 0 && findingIds.length === 0) {
    throw new Error("--fix-group requires at least one --finding-id");
  }
  const reviewScope: ReviewScope | undefined = findingIds.length > 0
    ? reviewId
      ? { mode: "this-review", reviewId, findingIds: [...new Set(findingIds)] }
      : reviewHeadSha
        ? { mode: "all-current-findings", headSha: reviewHeadSha, findingIds: [...new Set(findingIds)] }
        : (() => {
            throw new Error("scoped findings require --review-id or --review-head-sha");
          })()
    : undefined;
  if (findingIds.length > 0 && new Set(findingIds).size !== findingIds.length) {
    throw new Error("finding IDs must be unique");
  }
  const fixGroups = parseFixGroups(fixGroupValues, findingIds);
  const hasHandoffField = Boolean(handoffFromOwnerId || handoffId || authorizedBy);
  let ownership: ReviewOwnershipAuthorization | undefined;
  if (hasHandoffField) {
    if (!ownerId || !handoffFromOwnerId || !handoffId || !authorizedBy) {
      throw new Error("--owner-id, --handoff-from-owner, --handoff-id, and --authorized-by are required for an explicit handoff");
    }
    ownership = {
      mode: "explicit-handoff",
      ownerId,
      fromOwnerId: handoffFromOwnerId,
      handoffId,
      authorizedBy,
      source: "operator",
    };
  } else if (ownerId) {
    ownership = { mode: "local-owner", ownerId, source: "operator" };
  }
  const selectedDeliveryMode = deliveryMode ?? (publish ? "follow-up-pr" : "patch");
  if (publish && (selectedDeliveryMode === "commit" || selectedDeliveryMode === "follow-up-pr") && !ownership) {
    throw new Error("publishing review repairs requires ownership authorization");
  }
  if (publish && selectedDeliveryMode === "commit" && ownership?.mode !== "explicit-handoff") {
    throw new Error("direct review commit requires an explicit ownership handoff");
  }
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) {
    throw new Error("timeout must be an integer between 1 and 120 minutes");
  }
  return {
    pullRequestUrl,
    verifyCommand,
    skillPath,
    publish,
    ...(deliveryMode ? { deliveryMode } : {}),
    ...(candidateId ? { candidateId } : {}),
    ...(ownership ? { ownership } : {}),
    ...(reviewScope ? { reviewScope } : {}),
    ...(fixGroups ? { fixGroups } : {}),
    timeoutMinutes,
  };
}
