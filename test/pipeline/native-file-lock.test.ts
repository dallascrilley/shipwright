import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

type Runtime = "node" | "bun";
type ChildRole = "holder" | "deny" | "acquire";
type ChildReport = {
  event: "held" | "denied" | "acquired";
  ino: number;
  message?: string;
};

type LockDirectionEvidence = {
  holder: Runtime;
  contender: Runtime;
  heldInode: number;
  deniedInode: number;
  acquiredInode: number;
  denial: string;
};

const SUPPORTED_PLATFORM = process.platform === "darwin"
  || (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64"));
const REPOSITORY_ROOT = join(import.meta.dir, "..", "..");
const NODE_TSX_LOADER = join(REPOSITORY_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
const LOCK_MODULE_URL = pathToFileURL(join(REPOSITORY_ROOT, "src", "pipeline", "native-file-lock.ts")).href;

const HOLDER_SOURCE = String.raw`
import { closeSync, constants, fstatSync, openSync } from "node:fs";

const [role, lockPath, moduleUrl] = process.argv.slice(2);
if (!role || !lockPath || !moduleUrl) throw new Error("holder arguments are required");
const { acquireNativeFileLock } = await import(moduleUrl);

function inode(path: string): number {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    return Number(fstatSync(fd).ino);
  } finally {
    closeSync(fd);
  }
}

function report(value: { event: "held" | "denied" | "acquired"; ino: number; message?: string }): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

if (role === "holder") {
  const lock = await acquireNativeFileLock(lockPath);
  report({ event: "held", ino: inode(lockPath) });
  // A real interval keeps this separate holder alive until the parent kills it;
  // fake timers cannot control a different process.
  const { promise } = Promise.withResolvers<void>();
  setInterval(() => undefined, 1_000);
  await promise;
} else if (role === "deny") {
  const realNow = Date.now;
  const start = realNow();
  let calls = 0;
  Date.now = () => start + (calls++ < 10 ? 0 : 20_001);
  try {
    const lock = await acquireNativeFileLock(lockPath);
    const heldInode = inode(lockPath);
    await lock.release();
    report({ event: "acquired", ino: heldInode });
  } catch (error) {
    report({
      event: "denied",
      ino: inode(lockPath),
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    Date.now = realNow;
  }
} else if (role === "acquire") {
  const lock = await acquireNativeFileLock(lockPath);
  const heldInode = inode(lockPath);
  await lock.release();
  report({ event: "acquired", ino: heldInode });
} else {
  throw new Error("unknown holder role");
}
`;

function spawnRuntime(
  runtime: Runtime,
  role: ChildRole,
  helperPath: string,
  lockPath: string,
): Bun.ReadableSubprocess {
  // Load Node through the repository's tsx loader directly so killing the
  // holder kills the process that owns the native lock, not a tsx wrapper.
  const command = runtime === "node"
    ? ["node", "--import", NODE_TSX_LOADER]
    : ["bun"];
  return Bun.spawn([...command, helperPath, role, lockPath, LOCK_MODULE_URL], {
    cwd: REPOSITORY_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function parseReport(line: string): ChildReport | undefined {
  try {
    const parsed = JSON.parse(line) as {
      event?: unknown;
      ino?: unknown;
      message?: unknown;
    };
    if (
      (parsed.event === "held" || parsed.event === "denied" || parsed.event === "acquired")
      && typeof parsed.ino === "number"
    ) {
      return {
        event: parsed.event,
        ino: parsed.ino,
        ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
      };
    }
  } catch {
    // Ignore non-JSON runtime preamble; the helper's JSON report is authoritative.
  }
  return undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function waitForReport(child: Bun.ReadableSubprocess, timeoutMs: number, label: string): Promise<ChildReport> {
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!(stdout instanceof ReadableStream) || !(stderr instanceof ReadableStream)) {
    throw new Error("runtime proof child did not expose output pipes");
  }
  const stdoutReader = stdout.getReader();
  const stderrReader = stderr.getReader();
  const { promise, resolve, reject } = Promise.withResolvers<ChildReport>();
  let stdoutText = "";
  let stderrText = "";
  let settled = false;
  const cleanup = () => {
    clearTimeout(timer);
    void stdoutReader.cancel().catch(() => undefined);
    void stderrReader.cancel().catch(() => undefined);
  };
  const finish = (error?: Error, report?: ChildReport) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) reject(error);
    else if (report) resolve(report);
    else reject(new Error("runtime proof child produced no report"));
  };
  // This real timer only bounds a separate-process integration wait; success
  // completes on the child's report or exit event, not on elapsed time.
  const timer = setTimeout(() => {
    finish(new Error(`${label}: runtime proof child report timed out after ${timeoutMs}ms; pid=${child.pid}; exitCode=${child.exitCode}; signalCode=${child.signalCode}; stdout=${stdoutText}; stderr=${stderrText}`));
  }, timeoutMs);
  const consumeStderr = async () => {
    const decoder = new TextDecoder();
    try {
      while (!settled) {
        const result = await stderrReader.read();
        if (result.done) return;
        stderrText += decoder.decode(result.value, { stream: true });
      }
    } catch (error) {
      if (!settled) finish(asError(error));
    }
  };
  const consumeStdout = async () => {
    const decoder = new TextDecoder();
    try {
      while (!settled) {
        const result = await stdoutReader.read();
        if (result.done) {
          finish(new Error(`runtime proof child exited before reporting; stdout=${stdoutText}; stderr=${stderrText}`));
          return;
        }
        stdoutText += decoder.decode(result.value, { stream: true });
        for (const line of stdoutText.split(/\r?\n/)) {
          const report = parseReport(line);
          if (report) {
            finish(undefined, report);
            return;
          }
        }
      }
    } catch (error) {
      if (!settled) finish(asError(error));
    }
  };
  void consumeStderr();
  void consumeStdout();
  return promise;
}

async function waitForExit(child: Bun.ReadableSubprocess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let settled = false;
  const cleanup = () => clearTimeout(timer);
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) reject(error);
    else resolve();
  };
  // This real timer only bounds cleanup of a separate process; normal
  // completion comes from the child's exit event.
  const timer = setTimeout(() => {
    finish(new Error(`runtime proof child did not exit within ${timeoutMs}ms`));
  }, timeoutMs);
  void child.exited.then(() => finish(), (error) => finish(asError(error)));
  return promise;
}

async function stopChild(child: Bun.ReadableSubprocess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  try {
    await waitForExit(child, 3_000);
  } catch {
    // The test's primary assertions report the first failure; cleanup remains best effort.
  }
}

async function exerciseDirection(
  holderRuntime: Runtime,
  contenderRuntime: Runtime,
): Promise<LockDirectionEvidence> {
  const root = await mkdtemp(join(tmpdir(), "shipwright-native-lock-"));
  const lockPath = join(root, "shared.lock");
  const helperPath = join(root, "holder.mts");
  await writeFile(lockPath, "");
  await writeFile(helperPath, HOLDER_SOURCE);
  const children: Bun.ReadableSubprocess[] = [];
  try {
    const holder = spawnRuntime(holderRuntime, "holder", helperPath, lockPath);
    children.push(holder);
    const held = await waitForReport(holder, 10_000, `${holderRuntime} holder`);
    expect(held.event).toBe("held");
    expect(held.ino).toBeGreaterThan(0);
    expect(holder.exitCode).toBeNull();

    const deniedChild = spawnRuntime(contenderRuntime, "deny", helperPath, lockPath);
    children.push(deniedChild);
    const denied = await waitForReport(deniedChild, 3_000, `${contenderRuntime} denial contender`);
    await waitForExit(deniedChild, 3_000);
    expect(denied.event).toBe("denied");
    expect(denied.message).toMatch(/timed out acquiring native file lock/);
    expect(denied.ino).toBe(held.ino);
    expect(holder.exitCode).toBeNull();

    holder.kill("SIGKILL");
    await waitForExit(holder, 3_000);

    const acquiredChild = spawnRuntime(contenderRuntime, "acquire", helperPath, lockPath);
    children.push(acquiredChild);
    const acquired = await waitForReport(acquiredChild, 3_000, `${contenderRuntime} post-death contender`);
    await waitForExit(acquiredChild, 3_000);
    expect(acquired.event).toBe("acquired");
    expect(acquired.ino).toBe(held.ino);

    return {
      holder: holderRuntime,
      contender: contenderRuntime,
      heldInode: held.ino,
      deniedInode: denied.ino,
      acquiredInode: acquired.ino,
      denial: denied.message ?? "",
    };
  } finally {
    await Promise.all(children.map((child) => stopChild(child)));
    await rm(root, { recursive: true, force: true });
  }
}

const nativeLockTest = SUPPORTED_PLATFORM ? test : test.skip;
if (!SUPPORTED_PLATFORM) {
  console.info(`native-file-lock cross-runtime proof skipped: unsupported ${process.platform}/${process.arch}`);
}

nativeLockTest("proves Node and Bun native lock interoperability in both directions", async () => {
  const directions = [
    await exerciseDirection("node", "bun"),
    await exerciseDirection("bun", "node"),
  ];
  console.info(`native-file-lock proof ${JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    directions,
    linuxFcntlRoute: process.platform === "linux" ? "exercised" : "unproven until Linux CI",
  })}`);
});
