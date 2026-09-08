declare module "fs-native-extensions" {
  export function tryLock(
    fd: number,
    offset?: number,
    length?: number,
    options?: Record<string, unknown>,
  ): boolean;
  export function unlock(fd: number, offset?: number, length?: number): void;
}
