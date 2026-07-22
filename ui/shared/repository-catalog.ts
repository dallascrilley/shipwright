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

export function normalizeRepositoryIdentifier(value: string): string | undefined {
  const parsed = repositoryIdentifierSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
