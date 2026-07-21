import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");
const script = join(repoRoot, "deploy", "control-plane-state.sh");

const SNAPSHOT = JSON.stringify({
  version: 1,
  agents: [],
  revisions: [],
  triggers: [],
  lifecycleEvents: [],
  executions: [],
  queueEntries: [],
});

function run(args: string[]): { code: number; output: string } {
  const result = Bun.spawnSync(["bash", script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

describe("control-plane state backup/restore", () => {
  test("backup captures the snapshot with a checksum and restore round-trips it", () => {
    const root = mkdtempSync(join(tmpdir(), "shipwright-state-drill-"));
    try {
      const stateDir = join(root, "state");
      const backupDir = join(root, "backups");
      const restoreDir = join(root, "restored");
      Bun.spawnSync(["mkdir", "-p", stateDir]);
      writeFileSync(join(stateDir, "agent-control-plane.json"), SNAPSHOT, {
        mode: 0o600,
      });

      const backup = run(["backup", stateDir, backupDir]);
      expect(backup.code).toBe(0);
      const backups = readdirSync(backupDir).filter((name) =>
        name.endsWith(".sha256") ? false : true,
      );
      expect(backups).toHaveLength(1);
      const checksum = readFileSync(
        join(backupDir, `${backups[0]}.sha256`),
        "utf8",
      ).trim();
      expect(checksum).toMatch(/^[0-9a-f]{64}$/);

      const restore = run(["restore", join(backupDir, backups[0]), restoreDir]);
      expect(restore.code).toBe(0);
      expect(readFileSync(join(restoreDir, "agent-control-plane.json"), "utf8")).toBe(
        SNAPSHOT,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restore refuses a corrupt backup instead of replacing live state", () => {
    const root = mkdtempSync(join(tmpdir(), "shipwright-state-drill-"));
    try {
      const stateDir = join(root, "state");
      const backupFile = join(root, "bad-backup.json");
      writeFileSync(backupFile, '{"version":2,"agents":"corrupt"}', "utf8");

      const restore = run(["restore", backupFile, stateDir]);
      expect(restore.code).not.toBe(0);
      expect(restore.output).toContain("control-plane snapshot");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("backup fails clearly when no snapshot exists", () => {
    const root = mkdtempSync(join(tmpdir(), "shipwright-state-drill-"));
    try {
      const missing = run(["backup", join(root, "missing"), join(root, "out")]);
      expect(missing.code).toBe(1);
      expect(missing.output).toContain("No control-plane snapshot");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
