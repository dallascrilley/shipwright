import { basename, dirname, resolve } from "node:path";

export function resolveShipwrightStateDirectory(
  cwd = process.cwd(),
  configured = process.env.SHIPWRIGHT_STATE_DIR?.trim(),
): string {
  const repositoryRoot = basename(cwd) === "ui" ? dirname(cwd) : cwd;
  if (configured) return resolve(repositoryRoot, configured);
  return resolve(repositoryRoot, ".artifacts/shipwright");
}
