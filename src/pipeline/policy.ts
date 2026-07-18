interface ChangeSummary {
  changedFiles: string[];
  patchBytes: number;
}

const MAX_CHANGED_FILES = 100;
const MAX_PATCH_BYTES = 1024 * 1024;

export function assertPublishableChange(summary: ChangeSummary): void {
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
}
