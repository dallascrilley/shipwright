import { createRequire } from "node:module";
import { closeSync, constants, fstatSync, mkdirSync, openSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const F_OFD_SETLK = 37;
const F_WRLCK = 1;
const F_UNLCK = 2;
const SEEK_SET = 0;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_OPEN_FLAGS = constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW;
const SYNC_WAIT_SIGNAL = new Int32Array(new SharedArrayBuffer(4));
const LINUX_BUSY_ERRNOS = new Set([11, 13]);

export type HeldLockCheck = () => Promise<void>;
export type HeldSyncLockCheck = () => void;

interface NodeNativeLocks {
  tryLock(fd: number): boolean;
  unlock(fd: number): void;
}

interface BunFfiSymbols {
  flock?: (fd: number, operation: number) => number;
  fcntl?: (fd: number, command: number, data: Uint8Array) => number;
  readErrno?: () => number;
}

interface BunFfiModule {
  FFIType: { i32: unknown; ptr: unknown };
  read: { i32(pointer: number, byteOffset: number): number };
  dlopen(
    path: string,
    symbols: Record<string, { args: unknown[]; returns: unknown }>,
  ): { symbols: BunFfiSymbols };
}

const bunRequire = createRequire(import.meta.url);
let bunNativeLocks: { tryLock(fd: number): boolean; unlock(fd: number): void } | undefined;
const nodeLocks: NodeNativeLocks | undefined = process.versions.bun
  ? undefined
  : ((await import("fs-native-extensions")) as NodeNativeLocks);

function getBunLocks() {
  if (bunNativeLocks) return bunNativeLocks;
  // This platform-specific module cannot be statically imported: Node cannot
  // resolve bun:ffi, and a Bun import of the Node N-API addon crashes.
  const ffi = bunRequire("bun:ffi") as BunFfiModule;
  const library =
    process.platform === "darwin"
      ? "/usr/lib/libSystem.B.dylib"
      : process.platform === "linux"
        ? "libc.so.6"
        : undefined;
  if (!library) throw new Error(`native file locks are unsupported on ${process.platform}`);
  if (process.platform === "linux" && process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`native Linux file locks are unsupported on ${process.arch}`);
  }
  const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location";
  const errnoLibrary = ffi.dlopen(library, {
    [errnoSymbol]: { args: [], returns: ffi.FFIType.ptr },
  }).symbols as unknown as Record<string, () => number>;
  const readErrno = () => ffi.read.i32(errnoLibrary[errnoSymbol]!(), 0);
  const isBusyErrno = (errno: number) =>
    process.platform === "darwin" ? errno === 35 : LINUX_BUSY_ERRNOS.has(errno);
  const checkResult = (operation: string, result: number): boolean => {
    if (result === 0) return true;
    const errno = readErrno();
    if (result === -1 && isBusyErrno(errno)) return false;
    throw new Error(`native ${operation} failed (result ${result}, errno ${errno})`);
  };
  if (process.platform === "darwin") {
    const symbols = ffi.dlopen(library, {
      flock: { args: [ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
    }).symbols as unknown as { flock: (fd: number, operation: number) => number };
    bunNativeLocks = {
      tryLock: (fd) => checkResult("flock", symbols.flock(fd, LOCK_EX | LOCK_NB)),
      unlock: (fd) => {
        if (!checkResult("flock", symbols.flock(fd, LOCK_UN))) {
          throw new Error("could not release native file lock");
        }
      },
    };
    return bunNativeLocks;
  }
  const symbols = ffi.dlopen(library, {
    fcntl: { args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
  }).symbols as unknown as { fcntl: (fd: number, command: number, data: Uint8Array) => number };
  bunNativeLocks = {
    tryLock: (fd) => checkResult("fcntl(F_OFD_SETLK)", symbols.fcntl(fd, F_OFD_SETLK, LINUX_LOCK_DATA)),
    unlock: (fd) => {
      if (!checkResult("fcntl(F_OFD_SETLK)", symbols.fcntl(fd, F_OFD_SETLK, LINUX_UNLOCK_DATA))) {
        throw new Error("could not release native file lock");
      }
    },
  };
  return bunNativeLocks;
}

function createLinuxLockData(type: number): Uint8Array {
  const data = new Uint8Array(32);
  const view = new DataView(data.buffer);
  view.setInt16(0, type, true);
  view.setInt16(2, SEEK_SET, true);
  view.setBigInt64(8, 0n, true);
  view.setBigInt64(16, 0n, true);
  view.setInt32(24, 0, true);
  return data;
}

const LINUX_LOCK_DATA = createLinuxLockData(F_WRLCK);
const LINUX_UNLOCK_DATA = createLinuxLockData(F_UNLCK);

function getNodeLocks(): NodeNativeLocks {
  if (!nodeLocks) throw new Error("native file locks are unavailable in Bun");
  return nodeLocks;
}

function tryLock(fd: number): boolean {
  if (process.versions.bun) return getBunLocks().tryLock(fd);
  return getNodeLocks().tryLock(fd);
}

function unlock(fd: number): void {
  if (process.versions.bun) {
    getBunLocks().unlock(fd);
    return;
  }
  getNodeLocks().unlock(fd);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitSynchronously(milliseconds: number): void {
  Atomics.wait(SYNC_WAIT_SIGNAL, 0, 0, milliseconds);
}

async function openLockFile(lockPath: string) {
  const file = await open(lockPath, LOCK_OPEN_FLAGS, 0o600);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error(`native lock path must be a regular file: ${lockPath}`);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

function openLockFileSync(lockPath: string): number {
  const fd = openSync(lockPath, LOCK_OPEN_FLAGS, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`native lock path must be a regular file: ${lockPath}`);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

async function acquire(fd: number, lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (!tryLock(fd)) {
    if (Date.now() >= deadline) throw new Error(`timed out acquiring native file lock at ${lockPath}`);
    await wait(10);
  }
}

function acquireSync(fd: number, lockPath: string): void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (!tryLock(fd)) {
    if (Date.now() >= deadline) throw new Error(`timed out acquiring native file lock at ${lockPath}`);
    waitSynchronously(10);
  }
}

export interface NativeFileLockHandle {
  assertHeld: HeldLockCheck;
  release(): Promise<void>;
}

export async function acquireNativeFileLock(lockPath: string): Promise<NativeFileLockHandle> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const file = await openLockFile(lockPath);
  try {
    await acquire(file.fd, lockPath);
  } catch (error) {
    await file.close();
    throw error;
  }
  let held = true;
  let released = false;
  const assertHeld = async () => {
    if (!held) throw new Error(`native file lock ownership was lost at ${lockPath}`);
  };
  const release = async () => {
    if (released) return;
    released = true;
    held = false;
    try {
      unlock(file.fd);
    } finally {
      await file.close();
    }
  };
  return { assertHeld, release };
}

export async function withNativeFileLock<T>(
  lockPath: string,
  operation: (assertHeld: HeldLockCheck) => Promise<T>,
): Promise<T> {
  const lock = await acquireNativeFileLock(lockPath);
  try {
    return await operation(lock.assertHeld);
  } finally {
    await lock.release();
  }
}

export function withNativeFileLockSync<T>(
  lockPath: string,
  operation: (assertHeld: HeldSyncLockCheck) => T,
): T {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const fd = openLockFileSync(lockPath);
  let held = false;
  try {
    acquireSync(fd, lockPath);
    held = true;
    const assertHeld = () => {
      if (!held) throw new Error(`native file lock ownership was lost at ${lockPath}`);
    };
    return operation(assertHeld);
  } finally {
    if (held) {
      held = false;
      try {
        unlock(fd);
      } finally {
        closeSync(fd);
      }
    } else {
      closeSync(fd);
    }
  }
}
