import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function run(
  args: string[],
  env: Record<string, string | undefined> = {},
): { code: number; output: string } {
  const result = Bun.spawnSync(["bash", script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
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
      expect(
        readFileSync(join(restoreDir, "agent-control-plane.json"), "utf8"),
      ).toBe(SNAPSHOT);
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
      expect(restore.output).toContain("not a valid control-plane snapshot");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restore rejects a structurally incomplete v1 snapshot and keeps live state", () => {
    const root = mkdtempSync(join(tmpdir(), "shipwright-state-drill-"));
    try {
      const stateDir = join(root, "state");
      Bun.spawnSync(["mkdir", "-p", stateDir]);
      const live = join(stateDir, "agent-control-plane.json");
      writeFileSync(live, SNAPSHOT, { mode: 0o600 });
      const shallow = join(root, "shallow.json");
      writeFileSync(
        shallow,
        '{"version":1,"agents":[{"agentId":"agent-evil","enabled":true}]}',
        "utf8",
      );

      const restore = run(["restore", shallow, stateDir]);
      expect(restore.code).not.toBe(0);
      expect(readFileSync(live, "utf8")).toBe(SNAPSHOT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restore refuses a tampered backup whose checksum sidecar disagrees", () => {
    const root = mkdtempSync(join(tmpdir(), "shipwright-state-drill-"));
    try {
      const stateDir = join(root, "state");
      const backupDir = join(root, "backups");
      Bun.spawnSync(["mkdir", "-p", stateDir]);
      writeFileSync(join(stateDir, "agent-control-plane.json"), SNAPSHOT, {
        mode: 0o600,
      });
      expect(run(["backup", stateDir, backupDir]).code).toBe(0);
      const backup = readdirSync(backupDir).find(
        (name) => !name.endsWith(".sha256"),
      )!;
      const backupPath = join(backupDir, backup);
      writeFileSync(
        backupPath,
        SNAPSHOT.replace('"version":1', '"version":1 '),
        "utf8",
      );

      const restore = run(["restore", backupPath, join(root, "restored")]);
      expect(restore.code).toBe(1);
      expect(restore.output).toContain("Checksum mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restore retains the displaced live snapshot as a .bak file", () => {
    const root = mkdtempSync(join(tmpdir(), "shipwright-state-drill-"));
    try {
      const stateDir = join(root, "state");
      const backupDir = join(root, "backups");
      Bun.spawnSync(["mkdir", "-p", stateDir]);
      writeFileSync(join(stateDir, "agent-control-plane.json"), SNAPSHOT, {
        mode: 0o600,
      });
      expect(run(["backup", stateDir, backupDir]).code).toBe(0);
      const backup = readdirSync(backupDir).find(
        (name) => !name.endsWith(".sha256"),
      )!;
      writeFileSync(
        join(stateDir, "agent-control-plane.json"),
        SNAPSHOT.replace("[]", '["changed"]'),
        { mode: 0o600 },
      );

      expect(run(["restore", join(backupDir, backup), stateDir]).code).toBe(0);
      expect(
        readFileSync(join(stateDir, "agent-control-plane.json.bak"), "utf8"),
      ).toContain('"changed"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restore reapplies the service owner before the atomic replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "shipwright-state-drill-"));
    try {
      const stateDir = join(root, "state");
      const backup = join(root, "backup.json");
      const fakeBin = join(root, "bin");
      const chownLog = join(root, "chown.log");
      Bun.spawnSync(["mkdir", "-p", stateDir, fakeBin]);
      writeFileSync(join(stateDir, "agent-control-plane.json"), SNAPSHOT, {
        mode: 0o600,
      });
      writeFileSync(backup, SNAPSHOT, { mode: 0o600 });
      const fakeChown = join(fakeBin, "chown");
      writeFileSync(
        fakeChown,
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SHIPWRIGHT_CHOWN_LOG"\n',
      );
      chmodSync(fakeChown, 0o755);

      const restore = run(["restore", backup, stateDir], {
        PATH: `${fakeBin}:${process.env.PATH}`,
        SHIPWRIGHT_STATE_OWNER: "4242:4343",
        SHIPWRIGHT_CHOWN_LOG: chownLog,
      });

      expect(restore.code).toBe(0);
      expect(existsSync(chownLog)).toBe(true);
      expect(readFileSync(chownLog, "utf8")).toMatch(
        /4242:4343 .*agent-control-plane\.json\.restore\./,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restore leaves live state untouched when ownership cannot be applied", () => {
    const root = mkdtempSync(join(tmpdir(), "shipwright-state-drill-"));
    try {
      const stateDir = join(root, "state");
      const live = join(stateDir, "agent-control-plane.json");
      const backup = join(root, "backup.json");
      const fakeBin = join(root, "bin");
      Bun.spawnSync(["mkdir", "-p", stateDir, fakeBin]);
      writeFileSync(live, "previous live state", { mode: 0o600 });
      writeFileSync(backup, SNAPSHOT, { mode: 0o600 });
      const fakeChown = join(fakeBin, "chown");
      writeFileSync(fakeChown, "#!/bin/sh\nexit 73\n");
      chmodSync(fakeChown, 0o755);

      const restore = run(["restore", backup, stateDir], {
        PATH: `${fakeBin}:${process.env.PATH}`,
        SHIPWRIGHT_STATE_OWNER: "4242:4343",
      });

      expect(restore.code).toBe(73);
      expect(readFileSync(live, "utf8")).toBe("previous live state");
      expect(existsSync(`${live}.bak`)).toBe(false);
      expect(
        readdirSync(stateDir).some((name) => name.includes(".restore.")),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restore works under a hostile CDPATH from a relative invocation", () => {
    const root = mkdtempSync(join(tmpdir(), "shipwright-state-drill-"));
    try {
      const stateDir = join(root, "state");
      const backupDir = join(root, "backups");
      Bun.spawnSync(["mkdir", "-p", stateDir]);
      writeFileSync(join(stateDir, "agent-control-plane.json"), SNAPSHOT, {
        mode: 0o600,
      });
      expect(run(["backup", stateDir, backupDir]).code).toBe(0);
      const backup = readdirSync(backupDir).find(
        (name) => !name.endsWith(".sha256"),
      )!;

      const hostile = Bun.spawnSync(
        [
          "bash",
          "-c",
          `CDPATH=".:${root}" deploy/control-plane-state.sh restore "$1" "$2"`,
          "bash",
          join(backupDir, backup),
          join(root, "restored"),
        ],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
      );
      expect(hostile.exitCode).toBe(0);
      expect(
        readFileSync(
          join(root, "restored", "agent-control-plane.json"),
          "utf8",
        ),
      ).toBe(SNAPSHOT);
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
