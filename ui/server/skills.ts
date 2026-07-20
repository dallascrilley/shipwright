import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_REVIEW_SKILL_ID = "fix-review-findings";

export interface ResolvedSkill {
  id: string;
  /** Absolute path used only in-memory for pipeline deps — never persist. */
  path: string;
}

const KNOWN_SKILL_IDS = new Set([DEFAULT_REVIEW_SKILL_ID]);

function envPathForSkill(skillId: string): string | undefined {
  if (skillId === DEFAULT_REVIEW_SKILL_ID) {
    const value = process.env.SHIPWRIGHT_SKILL_FIX_REVIEW_FINDINGS?.trim();
    return value || undefined;
  }
  return undefined;
}

function defaultHubArtifactPath(skillId: string): string {
  return join(
    homedir(),
    ".hub",
    "artifacts",
    "skills",
    skillId,
    "source",
    "SKILL.md",
  );
}

export function isKnownSkillId(skillId: string): boolean {
  return KNOWN_SKILL_IDS.has(skillId);
}

/** Map a legacy absolute path to a skillId when basename/path matches a known skill. */
export function skillIdFromLegacyPath(skillPath: string): string | undefined {
  const trimmed = skillPath.trim();
  if (!trimmed) return undefined;
  const base = basename(trimmed);
  const parent = basename(join(trimmed, ".."));
  if (base === "SKILL.md" && isKnownSkillId(parent)) return parent;
  if (trimmed.includes(`${DEFAULT_REVIEW_SKILL_ID}`) && base === "SKILL.md") {
    return DEFAULT_REVIEW_SKILL_ID;
  }
  return undefined;
}

export function resolveSkill(skillId: string): ResolvedSkill {
  const id = skillId.trim() || DEFAULT_REVIEW_SKILL_ID;
  if (!isKnownSkillId(id)) {
    throw new Error(`Unknown skillId: ${id}`);
  }
  const fromEnv = envPathForSkill(id);
  const candidates = [fromEnv, defaultHubArtifactPath(id)].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) {
      throw new Error(`Skill path for ${id} must be absolute.`);
    }
    if (existsSync(candidate)) {
      return { id, path: candidate };
    }
  }
  throw new Error(
    `Could not resolve skillId ${id}. Set SHIPWRIGHT_SKILL_FIX_REVIEW_FINDINGS to an absolute SKILL.md path.`,
  );
}
