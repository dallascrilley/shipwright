import { containsSecretLikeContent } from "./receipt.js";

interface ChangeSummary {
  changedFiles: string[];
  patchBytes: number;
  patch?: string;
}

const MAX_CHANGED_FILES = 100;
const MAX_PATCH_BYTES = 1024 * 1024;

/**
 * The repair agent must not be able to satisfy verification by editing the
 * files the verification command depends on. A protected entry matches the
 * exact file or, as a directory, everything under it.
 */
export function findProtectedVerificationPath(
  changedFiles: readonly string[],
  protectedPaths: readonly string[],
): string | undefined {
  if (protectedPaths.length === 0) return undefined;
  return changedFiles.find((file) =>
    protectedPaths.some(
      (entry) => file === entry || file.startsWith(`${entry.replace(/\/+$/, "")}/`),
    ),
  );
}

export function assertPublishableChange(
  summary: ChangeSummary,
  protectedVerificationPaths: readonly string[] = [],
): void {
  if (summary.changedFiles.length === 0) {
    throw new Error("publication blocked: no changes were produced");
  }
  if (summary.changedFiles.length > MAX_CHANGED_FILES) {
    throw new Error(`publication blocked: changed file limit is ${MAX_CHANGED_FILES}`);
  }
  if (summary.patchBytes > MAX_PATCH_BYTES) {
    throw new Error(`publication blocked: patch limit is ${MAX_PATCH_BYTES} bytes`);
  }

  const protectedPath = summary.changedFiles.find(
    (path) => path === ".git" || path.startsWith(".git/") || path.startsWith(".github/workflows/"),
  );
  if (protectedPath) {
    throw new Error(`publication blocked: protected path changed: ${protectedPath}`);
  }
  const verificationPath = findProtectedVerificationPath(
    summary.changedFiles,
    protectedVerificationPaths,
  );
  if (verificationPath) {
    throw new Error(
      `publication blocked: verification-protected path changed: ${verificationPath}`,
    );
  }

  if (summary.patch && containsSecretLikeContent(summary.patch)) {
    throw new Error("publication blocked: patch appears to contain a secret");
  }
}
