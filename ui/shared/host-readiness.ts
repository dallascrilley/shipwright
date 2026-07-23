export const HOST_READINESS_STATUSES = [
  "ready",
  "not_configured",
  "unavailable",
] as const;

export type HostReadinessStatus = (typeof HOST_READINESS_STATUSES)[number];

export const HOST_READINESS_COMPONENTS = [
  "provider",
  "github_app",
  "docker",
  "state_store",
] as const;

export type HostReadinessComponentId =
  (typeof HOST_READINESS_COMPONENTS)[number];

/** Fixed explanation codes only — never free-form secret-bearing text. */
export const HOST_READINESS_CODES = [
  "demo_mode",
  "provider_configured",
  "provider_missing",
  "github_app_configured",
  "github_app_missing",
  "github_app_key_unreadable",
  "docker_socket_ready",
  "docker_socket_missing",
  "docker_socket_unreadable",
  "state_store_ready",
  "state_store_unreadable",
  "state_store_missing",
] as const;

export type HostReadinessCode = (typeof HOST_READINESS_CODES)[number];

export interface HostReadinessComponent {
  id: HostReadinessComponentId;
  status: HostReadinessStatus;
  code: HostReadinessCode;
  checkedAt: string;
  /** Non-secret identity only (e.g. provider name). Never credentials. */
  detail?: string;
}

export interface HostReadinessReport {
  demoMode: boolean;
  checkedAt: string;
  components: HostReadinessComponent[];
  /** True when live starts are clearly impossible from readiness alone. */
  blocksLiveStart: boolean;
}

export const HOST_READINESS_CODE_LABELS: Record<HostReadinessCode, string> = {
  demo_mode: "Demo mode — live host checks are advisory only.",
  provider_configured: "Model provider credentials are configured on the host.",
  provider_missing: "No model provider credential is configured.",
  github_app_configured: "GitHub App id and private key source are configured.",
  github_app_missing: "GitHub App id or private key source is not configured.",
  github_app_key_unreadable:
    "GitHub App private key path is configured but not readable.",
  docker_socket_ready: "Docker socket path is present and readable.",
  docker_socket_missing: "Docker socket path is not present.",
  docker_socket_unreadable: "Docker socket path exists but is not readable.",
  state_store_ready: "Operator state directory is readable.",
  state_store_unreadable: "Operator state directory is not readable.",
  state_store_missing: "Operator state directory is not present yet.",
};

export function labelForReadinessCode(code: HostReadinessCode): string {
  return HOST_READINESS_CODE_LABELS[code];
}

/**
 * Aggregate whether live starts should be disabled from readiness alone.
 * Demo mode never hard-blocks the console (dry-run remains available).
 */
export function resolveBlocksLiveStart(
  demoMode: boolean,
  components: readonly HostReadinessComponent[],
): boolean {
  if (demoMode) return false;
  return components.some(
    (component) =>
      component.status === "not_configured" ||
      component.status === "unavailable",
  );
}

export function buildHostReadinessReport(input: {
  demoMode: boolean;
  checkedAt: string;
  components: HostReadinessComponent[];
}): HostReadinessReport {
  return {
    demoMode: input.demoMode,
    checkedAt: input.checkedAt,
    components: input.components,
    blocksLiveStart: resolveBlocksLiveStart(input.demoMode, input.components),
  };
}
