import "server-only";

import { findRepositoryRoot } from "@memeval/repo-paths";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const decisionFieldSchema = z.enum([
  "decision",
  "linked_issue",
  "symptom_class",
  "severity",
  "customer_reply",
]);

const decisionValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const decisionSchema = z.object({
  decision: decisionValueSchema,
  linked_issue: decisionValueSchema,
  symptom_class: decisionValueSchema,
  severity: decisionValueSchema,
  customer_reply: decisionValueSchema,
});

const fiveDecisionsSchema = z.tuple([
  decisionSchema,
  decisionSchema,
  decisionSchema,
  decisionSchema,
  decisionSchema,
]);

const verdictSchema = z.enum(["PASS", "FAIL", "NEUTRAL", "INCONCLUSIVE", "INSUFFICIENT"]);

const agentCountsSchema = z.object({
  pass: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
  neutral: z.number().int().nonnegative(),
  inconclusive: z.number().int().nonnegative(),
  // Older result artifacts predate INSUFFICIENT. Keep their strict validation,
  // while normalizing only this missing count into the current output shape.
  insufficient: z.number().int().nonnegative().default(0),
});

export const impactResultSchema = z.object({
  memory: z.string(),
  model: z.string(),
  effort: z.string(),
  runAt: z.string(),
  repetitions: z.number().int().positive(),
  phoenix: z.object({
    datasetId: z.string(),
    controlExperimentId: z.string(),
    treatmentExperimentId: z.string(),
  }),
  byAgent: z.record(z.string(), agentCountsSchema),
  cases: z.array(
    z.object({
      id: z.string(),
      agent: z.string(),
      ticketId: z.string(),
      caseType: z.string(),
      ticketSubject: z.string(),
      ticketDescription: z.string(),
      expected: decisionSchema.partial(),
      gradedFields: z.array(decisionFieldSchema),
      controlPasses: z.number().int().nonnegative(),
      treatmentPasses: z.number().int().nonnegative(),
      verdict: verdictSchema,
      verdictReason: z.string(),
      controlDecisions: fiveDecisionsSchema,
      treatmentDecisions: fiveDecisionsSchema,
    }),
  ),
});

export type ImpactResult = z.infer<typeof impactResultSchema>;
export type ImpactCase = ImpactResult["cases"][number];
export type Decision = ImpactCase["controlDecisions"][number];
export type DecisionField = z.infer<typeof decisionFieldSchema>;
export type DecisionValue = z.infer<typeof decisionValueSchema>;
export type Verdict = z.infer<typeof verdictSchema>;

export async function readImpactResult(): Promise<ImpactResult | null> {
  try {
    const root = findRepositoryRoot(process.env.MEMEVAL_REPO_ROOT ?? import.meta.url);
    const contents = await readFile(path.join(root, "packages/evals/results/latest.json"), "utf8");
    const parsed: unknown = JSON.parse(contents);
    const result = impactResultSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function phoenixExperimentUrl(datasetId: string, experimentId: string): string {
  const baseUrl = (process.env.PHOENIX_BASE_URL ?? "http://localhost:6006").replace(/\/+$/u, "");
  return `${baseUrl}/datasets/${encodeURIComponent(datasetId)}/compare?experimentId=${encodeURIComponent(experimentId)}`;
}
