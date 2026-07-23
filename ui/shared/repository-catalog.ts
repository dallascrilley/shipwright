import { z } from "zod";

const repositoryIdentifierSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/);

export const agentRepositoryOptionSchema = z
  .object({
    repository: repositoryIdentifierSchema,
    owner: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    defaultBranch: z.string().trim().min(1).max(255),
    visibility: z.enum(["public", "private", "internal"]),
    archived: z.boolean(),
    selectable: z.boolean(),
  })
  .strict();

export const repositoryCatalogErrorCodeSchema = z.enum([
  "not_configured",
  "github_unavailable",
  "no_repositories",
]);

export const agentRepositoryCatalogResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      repositories: z.array(agentRepositoryOptionSchema),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: repositoryCatalogErrorCodeSchema,
      message: z.string().trim().min(1).max(500),
    })
    .strict(),
]);

export type AgentRepositoryOption = z.infer<typeof agentRepositoryOptionSchema>;
export type AgentRepositoryCatalogResult = z.infer<
  typeof agentRepositoryCatalogResultSchema
>;

export type RepositoryPickerOption = AgentRepositoryOption & {
  current: boolean;
  unavailable: boolean;
};

export type RepositoryPickerView = {
  state: "loading" | "ready" | "empty" | "error";
  options: RepositoryPickerOption[];
  message?: string;
};

export function normalizeRepositoryIdentifier(
  value: string,
): string | undefined {
  const parsed = repositoryIdentifierSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function buildRepositoryPickerView(
  catalog: AgentRepositoryCatalogResult | undefined,
  query: string,
  currentRepository: string,
): RepositoryPickerView {
  if (!catalog) return { state: "loading", options: [] };

  const current = normalizeRepositoryIdentifier(currentRepository);
  const source = catalog.ok ? [...catalog.repositories] : [];
  if (current && !source.some((item) => item.repository === current)) {
    const [owner = "", name = ""] = current.split("/");
    source.push({
      repository: current,
      owner,
      name,
      defaultBranch: "",
      visibility: "private",
      archived: false,
      selectable: false,
    });
  }

  const normalizedQuery = query.trim().toLowerCase();
  const options = source
    .filter(
      (item) => !normalizedQuery || item.repository.includes(normalizedQuery),
    )
    .map((item) => ({
      ...item,
      current: item.repository === current,
      unavailable: !item.selectable,
    }))
    .sort((left, right) =>
      left.repository < right.repository
        ? -1
        : left.repository > right.repository
          ? 1
          : 0,
    );

  if (!catalog.ok) {
    return { state: "error", options, message: catalog.message };
  }
  return { state: options.length === 0 ? "empty" : "ready", options };
}

export function canSaveRepositorySelection(
  catalog: AgentRepositoryCatalogResult | undefined,
  originalRepository: string,
  nextRepository: string,
): boolean {
  const original = normalizeRepositoryIdentifier(originalRepository);
  const next = normalizeRepositoryIdentifier(nextRepository);
  if (!next) return false;
  if (original && original === next) return true;
  return (
    catalog?.ok === true &&
    catalog.repositories.some(
      (repository) => repository.repository === next && repository.selectable,
    )
  );
}
