import type { CaseType } from "./cases";

export type Verdict = "PASS" | "FAIL" | "NEUTRAL" | "INCONCLUSIVE";

export type VerdictInput = {
  caseType: CaseType;
  controlPasses: number;
  treatmentPasses: number;
  malformed: boolean;
};

/**
 * First matching rule wins. Later branches are not scored independently.
 */
export function decideVerdict(input: VerdictInput): { verdict: Verdict; reason: string } {
  if (input.malformed) {
    return { verdict: "INCONCLUSIVE", reason: "malformed" };
  }
  if (input.caseType === "HELP" && input.controlPasses >= 3) {
    return { verdict: "INCONCLUSIVE", reason: "control already correct" };
  }
  if (input.caseType === "HARM_CHECK" && input.controlPasses <= 2) {
    return { verdict: "INCONCLUSIVE", reason: "control already wrong" };
  }
  if (input.caseType === "HELP") {
    if (input.controlPasses <= 2 && input.treatmentPasses >= 4) {
      return { verdict: "PASS", reason: "memory helped" };
    }
    if (input.treatmentPasses <= 2) {
      return { verdict: "FAIL", reason: "memory did not help" };
    }
    return { verdict: "NEUTRAL", reason: "mixed result" };
  }
  if (input.controlPasses >= 4 && input.treatmentPasses <= 2) {
    return { verdict: "FAIL", reason: "memory harmed, FLIP" };
  }
  if (input.treatmentPasses >= 4) {
    return { verdict: "PASS", reason: "no harm done" };
  }
  return { verdict: "NEUTRAL", reason: "mixed result" };
}
