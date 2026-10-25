import type { CaseType } from "./cases";

export type Verdict = "PASS" | "FAIL" | "INSUFFICIENT" | "NEUTRAL" | "INCONCLUSIVE";

export type VerdictBranch =
  | "PASS-helped"
  | "PASS-no-harm"
  | "FAIL-worse"
  | "FAIL-flip"
  | "INSUFFICIENT"
  | "NEUTRAL"
  | "INCONCLUSIVE";

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
  } else if (input.caseType === "HELP" && input.controlPasses >= 3) {
    return { verdict: "INCONCLUSIVE", reason: "control already correct" };
  } else if (input.caseType === "HARM_CHECK" && input.controlPasses <= 2) {
    return { verdict: "INCONCLUSIVE", reason: "control already wrong" };
  } else if (input.caseType === "HELP") {
    if (input.treatmentPasses >= 4) {
      return { verdict: "PASS", reason: "memory helped" };
    } else if (input.treatmentPasses < input.controlPasses) {
      return { verdict: "FAIL", reason: "memory made it worse" };
    } else if (input.treatmentPasses > input.controlPasses) {
      return {
        verdict: "INSUFFICIENT",
        reason: `memory helped but not reliably (${input.treatmentPasses} of 5)`,
      };
    } else {
      return { verdict: "NEUTRAL", reason: "no observed effect" };
    }
  } else if (input.controlPasses >= 4 && input.treatmentPasses <= 2) {
    return { verdict: "FAIL", reason: "memory caused a regression (flip)" };
  } else if (input.treatmentPasses >= 4) {
    return { verdict: "PASS", reason: "no harm done" };
  } else if (input.treatmentPasses < input.controlPasses) {
    return {
      verdict: "NEUTRAL",
      reason: `treatment dropped ${input.controlPasses}/5 -> ${input.treatmentPasses}/5`,
    };
  } else if (input.treatmentPasses > input.controlPasses) {
    return {
      verdict: "NEUTRAL",
      reason: `treatment increased ${input.controlPasses}/5 -> ${input.treatmentPasses}/5`,
    };
  } else {
    return {
      verdict: "NEUTRAL",
      reason: `treatment unchanged at ${input.controlPasses}/5`,
    };
  }
}

export function verdictBranch(result: {
  verdict: Verdict;
  caseType: CaseType;
  reason: string;
}): VerdictBranch {
  if (result.verdict === "PASS") {
    return result.caseType === "HELP" ? "PASS-helped" : "PASS-no-harm";
  } else if (result.verdict === "FAIL") {
    return result.caseType === "HELP" ? "FAIL-worse" : "FAIL-flip";
  } else {
    return result.verdict;
  }
}
