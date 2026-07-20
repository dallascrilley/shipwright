export interface VerifyPreset {
  id: string;
  label: string;
  command: string;
}

const PRESETS: readonly VerifyPreset[] = [
  { id: "bun-test", label: "bun test", command: "bun test" },
  {
    id: "bun-test-typecheck",
    label: "bun test && bun run typecheck",
    command: "bun test && bun run typecheck",
  },
] as const;

export const DEFAULT_VERIFY_PRESET_ID = "bun-test";

export function listVerifyPresets(): VerifyPreset[] {
  return PRESETS.map((preset) => ({ ...preset }));
}

export function resolveVerifyPreset(presetId: string): VerifyPreset {
  const id = presetId.trim();
  const preset = PRESETS.find((entry) => entry.id === id);
  if (!preset) {
    throw new Error(`Unknown verify preset: ${id}`);
  }
  return { ...preset };
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
    throw new Error("Verification command contains disallowed shell expansion syntax.");
  }
  return trimmed;
}
