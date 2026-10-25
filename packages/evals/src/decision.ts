import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const DECISIONS = ["link_to_known_issue", "escalate", "handle_normally"] as const;
export const SYMPTOM_CLASSES = [
  "name_encoding",
  "stale_config",
  "persistence",
  "auth",
  "tenant_isolation",
  "server_error",
  "rate_limit_request",
  "timeout_defect",
  "other",
] as const;
export const SEVERITIES = ["normal", "high", "critical"] as const;

export type DecisionName = (typeof DECISIONS)[number];
export type SymptomClass = (typeof SYMPTOM_CLASSES)[number];
export type Severity = (typeof SEVERITIES)[number];

/** Ordinal severity so comparisons such as "below high" use rank, not label order. */
export const SEVERITY_RANK: Record<Severity, number> = {
  normal: 1,
  high: 2,
  critical: 3,
};

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SEVERITY_RANK, value);
}

/** True when `severity` ranks strictly below `threshold` (normal < high < critical). */
export function isSeverityBelow(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[severity] < SEVERITY_RANK[threshold];
}

export const decisionSchema = z.object({
  decision: z.enum(DECISIONS),
  linked_issue: z.string().nullable(),
  symptom_class: z.enum(SYMPTOM_CLASSES),
  severity: z.enum(SEVERITIES),
  customer_reply: z.string(),
});

export type Decision = z.infer<typeof decisionSchema>;

const decisionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "linked_issue", "symptom_class", "severity", "customer_reply"],
  properties: {
    decision: {
      type: "string",
      enum: [...DECISIONS],
    },
    linked_issue: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    symptom_class: {
      type: "string",
      enum: [...SYMPTOM_CLASSES],
    },
    severity: {
      type: "string",
      enum: [...SEVERITIES],
    },
    customer_reply: {
      type: "string",
    },
  },
} as const;

/**
 * Structured output for messages.create.
 * zodOutputFormat supplies the parser. Its generated schema folds enum into a
 * description string, so the schema sent to the API keeps closed enum keywords.
 */
const parsedDecisionFormat = zodOutputFormat(decisionSchema);
export const decisionOutputFormat = {
  ...parsedDecisionFormat,
  schema: decisionJsonSchema,
};
