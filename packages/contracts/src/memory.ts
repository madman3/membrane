import { z } from "zod";

const requiredText = (max: number) =>
  z
    .string()
    .trim()
    .min(1, "This field is required.")
    .max(max, `Use ${max} characters or fewer.`);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined));

const scopeId = requiredText(120);

export const memoryStatusSchema = z.enum(["draft", "ready", "evaluating", "evaluated"]);

export const memoryScopeSchema = z.object({
  agentIds: z.array(scopeId).max(50).optional(),
  customerIds: z.array(scopeId).max(50).optional(),
  taskTypes: z.array(scopeId).max(50).optional(),
});

export const memoryProvenanceSchema = z.object({
  sourceSystem: requiredText(200),
  sourceRecordId: requiredText(200),
  observedAt: z.iso.datetime().optional(),
  description: optionalText(2000),
});

export const memoryCandidateSchema = z.object({
  id: z.uuid(),
  title: requiredText(200),
  content: requiredText(20_000),
  memoryType: requiredText(80),
  scope: memoryScopeSchema,
  provenance: memoryProvenanceSchema,
  status: memoryStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const memoryVersionSchema = z.object({
  id: z.uuid(),
  candidateId: z.uuid(),
  version: z.number().int().positive(),
  content: requiredText(20_000),
  createdAt: z.iso.datetime(),
});

export const memoryCandidateDetailSchema = memoryCandidateSchema.extend({
  versions: z.array(memoryVersionSchema),
});

export const memoryCandidateListSchema = z.array(memoryCandidateSchema);

export const createMemorySchema = z.object({
  title: requiredText(200),
  content: requiredText(20_000),
  memoryType: requiredText(80),
  scope: memoryScopeSchema.default({}),
  provenance: memoryProvenanceSchema,
  status: memoryStatusSchema.default("draft"),
});

export const createMemoryVersionSchema = z.object({
  content: requiredText(20_000),
});

export const memoryIdParamsSchema = z.object({
  id: z.uuid(),
});

export const healthSchema = z.object({
  status: z.literal("ok"),
  database: z.literal("connected"),
});

export const apiErrorDetailSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(apiErrorDetailSchema).optional(),
  }),
});

export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryProvenance = z.infer<typeof memoryProvenanceSchema>;
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
export type MemoryVersion = z.infer<typeof memoryVersionSchema>;
export type MemoryCandidateDetail = z.infer<typeof memoryCandidateDetailSchema>;
export type CreateMemoryInput = z.infer<typeof createMemorySchema>;
export type CreateMemoryVersionInput = z.infer<typeof createMemoryVersionSchema>;
export type HealthStatus = z.infer<typeof healthSchema>;
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
