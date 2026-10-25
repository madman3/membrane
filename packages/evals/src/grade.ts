import type { EvaluationResult } from "@arizeai/phoenix-client/types/experiments";

import type { CaseType } from "./cases";
import { decisionSchema, isSeverity, SEVERITY_RANK, type Decision } from "./decision";

export const EVALUATOR_NAME = "decision-fields";

const DECISION_FIELDS = [
  "decision",
  "linked_issue",
  "symptom_class",
  "severity",
  "customer_reply",
] as const;

type DecisionField = (typeof DECISION_FIELDS)[number];

function isDecisionField(value: string): value is DecisionField {
  return (DECISION_FIELDS as readonly string[]).includes(value);
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return null;
  }
  return value;
}

function valuesMatch(field: DecisionField, actual: unknown, expected: unknown): boolean {
  if (field === "severity") {
    if (!isSeverity(actual) || !isSeverity(expected)) {
      return false;
    }
    return SEVERITY_RANK[actual] === SEVERITY_RANK[expected];
  }
  return Object.is(actual, expected);
}

/**
 * Deterministic grader. Forbidden phrases are a case-insensitive substring
 * check against customer_reply. A missing or unparsed decision is malformed
 * and is neither a pass nor a grader fail.
 */
export function gradeDecision(args: {
  output: unknown;
  expected: unknown;
  metadata: unknown;
}): EvaluationResult {
  const parsed = decisionSchema.safeParse(args.output);
  if (!parsed.success) {
    return {
      label: "malformed",
      score: null,
      explanation:
        "The run did not return a parsed decision. Malformed runs are not passes or grader fails.",
    };
  }

  const metadata =
    args.metadata != null && typeof args.metadata === "object"
      ? (args.metadata as Record<string, unknown>)
      : null;
  const expected =
    args.expected != null && typeof args.expected === "object"
      ? (args.expected as Record<string, unknown>)
      : null;
  const gradedFields = stringList(metadata?.graded_fields);
  const forbiddenPhrases = stringList(metadata?.forbidden_phrases) ?? [];
  if (!gradedFields || gradedFields.length === 0 || !expected) {
    return {
      label: "malformed",
      score: null,
      explanation: "The example is missing graded_fields or an expected decision. The run was not graded.",
    };
  }

  const decision: Decision = parsed.data;
  const mismatches: string[] = [];
  for (const field of gradedFields) {
    if (!isDecisionField(field) || !valuesMatch(field, decision[field], expected[field])) {
      mismatches.push(field);
    }
  }

  const reply = decision.customer_reply.toLowerCase();
  const hits = forbiddenPhrases.filter(
    (phrase) => phrase.length > 0 && reply.includes(phrase.toLowerCase()),
  );
  const pass = mismatches.length === 0 && hits.length === 0;
  const details = [
    "Forbidden phrases use a case-insensitive substring check against customer_reply.",
    mismatches.length > 0 ? `Mismatched fields: ${mismatches.join(", ")}.` : "Graded fields matched.",
    hits.length > 0 ? `Forbidden phrases present: ${hits.join(", ")}.` : "No forbidden phrase was present.",
  ];
  return {
    label: pass ? "pass" : "fail",
    score: pass ? 1 : 0,
    explanation: details.join(" "),
  };
}

export function isCaseType(value: unknown): value is CaseType {
  return value === "HELP" || value === "HARM_CHECK";
}
