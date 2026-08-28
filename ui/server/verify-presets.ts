export interface VerifyPreset {
  id: string;
  label: string;
  command: string;
  /** Exact owner/repo matches, e.g. "acme/widgets". */
  repositories?: string[];
  /** Anchored globs against owner/repo, e.g. "acme/*". */
  repositoryGlobs?: string[];
  /**
   * Repo-relative files or directories the verification command depends on.
   * The review pipeline rejects agent changes that touch them, so a repair
   * cannot green the gate by editing the gate itself.
   */
  protectedPaths?: string[];
}

export type VerifyPresetSelectionSource =
  | "explicit"
  | "exact_repo"
  | "repo_glob"
  | "default"
  | "raw_command";

export interface VerifyPresetSelection {
  preset: VerifyPreset;
  selectionReason: string;
  source: VerifyPresetSelectionSource;
}

export interface SelectVerifyPresetInput {
  owner?: string;
  repo?: string;
  /** Non-empty means the operator chose this preset id. */
  requestedPresetId?: string;
}

const BUILTIN_PRESETS: readonly VerifyPreset[] = [
  { id: "bun-test", label: "bun test", command: "bun test" },
  {
    id: "bun-test-typecheck",
    label: "bun test && bun run typecheck",
    command: "bun test && bun run typecheck",
  },
];

export const DEFAULT_VERIFY_PRESET_ID = "bun-test";
export const VERIFY_PRESETS_ENV = "SHIPWRIGHT_VERIFY_PRESETS_JSON";

type PresetTable = {
  fingerprint: string;
  presets: VerifyPreset[];
};

let cachedTable: PresetTable | undefined;

function clonePreset(preset: VerifyPreset): VerifyPreset {
  return {
    id: preset.id,
    label: preset.label,
    command: preset.command,
    ...(preset.repositories
      ? { repositories: [...preset.repositories] }
      : {}),
    ...(preset.repositoryGlobs
      ? { repositoryGlobs: [...preset.repositoryGlobs] }
      : {}),
    ...(preset.protectedPaths
      ? { protectedPaths: [...preset.protectedPaths] }
      : {}),
  };
}

function normalizeRepoSlug(owner: string, repo: string): string {
  return `${owner.trim()}/${repo.trim()}`.toLowerCase();
}

function normalizeExactRepo(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
}

function compileAnchoredGlob(pattern: string): RegExp {
  const trimmed = pattern.trim();
  if (!trimmed) {
    throw new Error("repositoryGlobs entries must be non-empty");
  }
  let body = "";
  for (const char of trimmed) {
    if (char === "*") {
      body += ".*";
      continue;
    }
    if (/[.+?^${}()|[\]\\]/.test(char)) {
      body += `\\${char}`;
      continue;
    }
    body += char;
  }
  return new RegExp(`^${body}$`, "i");
}

/** Validate Advanced raw verify commands. */
export function assertSafeVerifyCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error("Verification command is required.");
  }
  if (trimmed.length > 500) {
    throw new Error("Verification command is too long.");
  }
  if (/[\u0000\r\n]/.test(trimmed)) {
    throw new Error("Verification command must be a single line.");
  }
  if (/`|\$\(|\$\{/.test(trimmed)) {
    throw new Error(
      "Verification command contains disallowed shell expansion syntax.",
    );
  }
  return trimmed;
}

function validatePreset(entry: unknown, index: number): VerifyPreset {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${VERIFY_PRESETS_ENV}[${index}] must be an object`);
  }
  const raw = entry as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!id) {
    throw new Error(`${VERIFY_PRESETS_ENV}[${index}].id is required`);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    throw new Error(`${VERIFY_PRESETS_ENV}[${index}].id is invalid: ${id}`);
  }
  if (!label) {
    throw new Error(`${VERIFY_PRESETS_ENV}[${index}].label is required`);
  }
  if (!command) {
    throw new Error(`${VERIFY_PRESETS_ENV}[${index}].command is required`);
  }
  assertSafeVerifyCommand(command);

  let repositories: string[] | undefined;
  if (raw.repositories !== undefined) {
    if (
      !Array.isArray(raw.repositories) ||
      raw.repositories.some((value) => typeof value !== "string")
    ) {
      throw new Error(
        `${VERIFY_PRESETS_ENV}[${index}].repositories must be a string array`,
      );
    }
    repositories = raw.repositories
      .map((value) => normalizeExactRepo(String(value)))
      .filter(Boolean);
    for (const repo of repositories) {
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
        throw new Error(
          `${VERIFY_PRESETS_ENV}[${index}].repositories entry must be owner/repo: ${repo}`,
        );
      }
    }
  }

  let repositoryGlobs: string[] | undefined;
  if (raw.repositoryGlobs !== undefined) {
    if (
      !Array.isArray(raw.repositoryGlobs) ||
      raw.repositoryGlobs.some((value) => typeof value !== "string")
    ) {
      throw new Error(
        `${VERIFY_PRESETS_ENV}[${index}].repositoryGlobs must be a string array`,
      );
    }
    repositoryGlobs = raw.repositoryGlobs
      .map((value) => String(value).trim())
      .filter(Boolean);
    for (const pattern of repositoryGlobs) {
      compileAnchoredGlob(pattern);
    }
  }

  let protectedPaths: string[] | undefined;
  if (raw.protectedPaths !== undefined) {
    if (
      !Array.isArray(raw.protectedPaths) ||
      raw.protectedPaths.some((value) => typeof value !== "string")
    ) {
      throw new Error(
        `${VERIFY_PRESETS_ENV}[${index}].protectedPaths must be a string array`,
      );
    }
    protectedPaths = raw.protectedPaths
      .map((value) => String(value).trim().replace(/^\.\//, "").replace(/\/+$/, ""))
      .filter(Boolean);
    for (const entry of protectedPaths) {
      if (
        entry.startsWith("/") ||
        entry.includes("\\") ||
        entry.split("/").some((segment) => segment === "..")
      ) {
        throw new Error(
          `${VERIFY_PRESETS_ENV}[${index}].protectedPaths entry must be a repo-relative path: ${entry}`,
        );
      }
    }
  }

  return {
    id,
    label,
    command,
    ...(repositories && repositories.length > 0 ? { repositories } : {}),
    ...(repositoryGlobs && repositoryGlobs.length > 0
      ? { repositoryGlobs }
      : {}),
    ...(protectedPaths && protectedPaths.length > 0 ? { protectedPaths } : {}),
  };
}

function buildPresetTable(envValue: string | undefined): VerifyPreset[] {
  const byId = new Map<string, VerifyPreset>();
  for (const preset of BUILTIN_PRESETS) {
    byId.set(preset.id, clonePreset(preset));
  }

  const raw = (envValue ?? "").trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${VERIFY_PRESETS_ENV} must be valid JSON`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${VERIFY_PRESETS_ENV} must be a JSON array`);
    }
    parsed.forEach((entry, index) => {
      const preset = validatePreset(entry, index);
      const existing = byId.get(preset.id);
      byId.set(preset.id, existing ? { ...existing, ...preset } : preset);
    });
  }

  if (!byId.has(DEFAULT_VERIFY_PRESET_ID)) {
    throw new Error(
      `${VERIFY_PRESETS_ENV} must keep default preset id "${DEFAULT_VERIFY_PRESET_ID}"`,
    );
  }

  return [...byId.values()];
}

function loadConfiguredPresets(
  env: NodeJS.ProcessEnv = process.env,
): VerifyPreset[] {
  const fingerprint = env[VERIFY_PRESETS_ENV] ?? "";
  if (cachedTable && cachedTable.fingerprint === fingerprint) {
    return cachedTable.presets;
  }
  const presets = buildPresetTable(fingerprint);
  cachedTable = { fingerprint, presets };
  return presets;
}

/**
 * Fail closed at process/module startup when host overlay config is present
 * and invalid. Empty env keeps builtins and does not throw.
 * Does not seed the request cache, so later tests may inject alternate env.
 */
export function validateVerifyPresetsAtStartup(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const raw = (env[VERIFY_PRESETS_ENV] ?? "").trim();
  if (!raw) return;
  // Validate only; do not populate cachedTable from process env here.
  buildPresetTable(raw);
}

/** Test helper: drop cached env-derived preset table. */
export function resetVerifyPresetCache(): void {
  cachedTable = undefined;
}

export function listVerifyPresets(
  env: NodeJS.ProcessEnv = process.env,
): VerifyPreset[] {
  return loadConfiguredPresets(env).map(clonePreset);
}

/**
 * Protected verification paths for one preset id, resolved server-side from
 * configuration so a client-supplied request can never weaken them. Blank or
 * unknown ids (raw commands, legacy records) resolve to no protection.
 */
export function resolveProtectedVerificationPaths(
  presetId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const id = presetId?.trim() ?? "";
  if (!id) return [];
  const preset = loadConfiguredPresets(env).find((entry) => entry.id === id);
  return preset?.protectedPaths ? [...preset.protectedPaths] : [];
}

export function resolveVerifyPreset(
  presetId: string,
  env: NodeJS.ProcessEnv = process.env,
): VerifyPreset {
  const id = presetId.trim();
  const preset = loadConfiguredPresets(env).find((entry) => entry.id === id);
  if (!preset) {
    throw new Error(`Unknown verify preset: ${id}`);
  }
  return clonePreset(preset);
}

function matchExact(
  presets: readonly VerifyPreset[],
  owner: string,
  repo: string,
): VerifyPreset | undefined {
  const slug = normalizeRepoSlug(owner, repo);
  return presets.find((preset) =>
    (preset.repositories ?? []).some((entry) => entry === slug),
  );
}

function matchGlob(
  presets: readonly VerifyPreset[],
  owner: string,
  repo: string,
): VerifyPreset | undefined {
  const slug = normalizeRepoSlug(owner, repo);
  return presets.find((preset) =>
    (preset.repositoryGlobs ?? []).some((pattern) =>
      compileAnchoredGlob(pattern).test(slug),
    ),
  );
}

/**
 * Pure selection: explicit operator preset wins; otherwise exact repo,
 * anchored glob, then default.
 */
export function selectVerifyPreset(
  input: SelectVerifyPresetInput = {},
  env: NodeJS.ProcessEnv = process.env,
): VerifyPresetSelection {
  const presets = loadConfiguredPresets(env);
  const requested = input.requestedPresetId?.trim() ?? "";

  if (requested) {
    const preset = resolveVerifyPreset(requested, env);
    return {
      preset,
      source: "explicit",
      selectionReason: `Operator selected preset ${preset.id}`,
    };
  }

  if (input.owner?.trim() && input.repo?.trim()) {
    const exact = matchExact(presets, input.owner, input.repo);
    if (exact) {
      const preset = clonePreset(exact);
      return {
        preset,
        source: "exact_repo",
        selectionReason: `Exact repository match for ${normalizeRepoSlug(input.owner, input.repo)} → ${preset.id}`,
      };
    }
    const glob = matchGlob(presets, input.owner, input.repo);
    if (glob) {
      const preset = clonePreset(glob);
      return {
        preset,
        source: "repo_glob",
        selectionReason: `Repository glob match for ${normalizeRepoSlug(input.owner, input.repo)} → ${preset.id}`,
      };
    }
  }

  const fallback = resolveVerifyPreset(DEFAULT_VERIFY_PRESET_ID, env);
  return {
    preset: fallback,
    source: "default",
    selectionReason: `Default preset ${fallback.id}`,
  };
}

/**
 * Resolve verification for start:
 * - useRawCommand => Advanced raw path (presetId empty)
 * - requestedPresetId => explicit preset (wins), but if it matches the
 *   target-aware recommendation the audit reason keeps the match source
 * - otherwise target-aware recommendation / default
 *
 * Does not overwrite a provided raw command with a preset.
 */
export function resolveStartVerifySelection(input: {
  owner?: string;
  repo?: string;
  requestedPresetId?: string;
  /** Present only for Advanced raw path (empty preset id). */
  rawVerifyCommand?: string;
  useRawCommand?: boolean;
  env?: NodeJS.ProcessEnv;
}): VerifyPresetSelection & { verifyCommand: string; presetId: string } {
  const env = input.env ?? process.env;
  const requested = input.requestedPresetId?.trim() ?? "";
  const useRaw = Boolean(input.useRawCommand);

  if (useRaw) {
    const command = assertSafeVerifyCommand(input.rawVerifyCommand ?? "");
    return {
      preset: {
        id: "",
        label: "raw command",
        command,
      },
      presetId: "",
      verifyCommand: command,
      source: "raw_command",
      selectionReason: "Operator-provided raw verification command",
    };
  }

  const recommended = selectVerifyPreset(
    { owner: input.owner, repo: input.repo },
    env,
  );

  if (!requested) {
    return {
      ...recommended,
      presetId: recommended.preset.id,
      verifyCommand: recommended.preset.command,
    };
  }

  const explicit = selectVerifyPreset(
    {
      owner: input.owner,
      repo: input.repo,
      requestedPresetId: requested,
    },
    env,
  );

  if (explicit.preset.id === recommended.preset.id) {
    return {
      ...recommended,
      presetId: recommended.preset.id,
      verifyCommand: recommended.preset.command,
    };
  }

  return {
    ...explicit,
    presetId: explicit.preset.id,
    verifyCommand: explicit.preset.command,
  };
}

// Validate host overlay configuration when this module is first loaded.
// Malformed SHIPWRIGHT_VERIFY_PRESETS_JSON must fail closed at startup, not on
// the first list/start request.
validateVerifyPresetsAtStartup();
