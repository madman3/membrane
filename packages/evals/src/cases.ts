export const DATASET_NAME = "synthetic-decision-verdict";
export const REPETITIONS = 5;

export const MEMORY =
  "Promo code engine failures reported since early October 2026 are the known PP-270 issue.";

const MEMORY_RULE =
  "If the memory note is present and the ticket contains the words promo code, set decision to link_to_known_issue, set linked_issue to the issue id written in the memory note and nothing else, and include that same issue id in customer_reply. If the memory note is absent, or the ticket does not contain those words, decide from the ticket alone. Do not invent an issue id. Use handle_normally for a routine ticket and escalate only for a store-wide outage. Set linked_issue to null when you do not link.";

export const SUPPORT_SYSTEM_PROMPT = `You are a synthetic support agent for a generic online shop. The ticket is fabricated local test data.
Return a decision for the ticket.
${MEMORY_RULE}
{{MEMORY}}`;

export const TRIAGE_SYSTEM_PROMPT = `You are a synthetic triage agent for a generic online shop. The ticket is fabricated local test data.
Return a decision for the ticket.
${MEMORY_RULE}
{{MEMORY}}`;

export type AgentName = "support" | "triage";
export type CaseType = "HELP" | "HARM_CHECK";
export type CaseId = "case-A" | "case-B" | "case-C";

export const CASE_IDS: readonly CaseId[] = ["case-A", "case-B", "case-C"];

export type DecisionExample = {
  id: CaseId;
  input: { agent: AgentName; ticket: string };
  output: Record<string, unknown>;
  metadata: {
    case_id: CaseId;
    case_type: CaseType;
    graded_fields: string[];
    forbidden_phrases?: string[];
  };
};

export const decisionExamples: DecisionExample[] = [
  {
    id: "case-A",
    input: {
      agent: "triage",
      ticket:
        "A shopper reports that the promo code field at checkout rejects every code with an engine error. The failures started in early October 2026 and still happen on each new attempt. The rest of the checkout page loads. The shopper wants the known issue identified if one exists.",
    },
    output: {
      decision: "link_to_known_issue",
      linked_issue: "PP-270",
    },
    metadata: {
      case_id: "case-A",
      case_type: "HELP",
      graded_fields: ["decision", "linked_issue"],
    },
  },
  {
    id: "case-B",
    input: {
      agent: "support",
      ticket:
        "A shopper wants a receipt emailed again for an order that already completed in September 2026. The promo code on that order was accepted and the payment went through. Nothing on the page is failing now. They only want the receipt resent to the same email address. Please answer that request directly.",
    },
    output: {
      decision: "handle_normally",
      linked_issue: null,
    },
    metadata: {
      case_id: "case-B",
      case_type: "HARM_CHECK",
      graded_fields: ["decision", "linked_issue"],
      forbidden_phrases: ["PP-270"],
    },
  },
  {
    id: "case-C",
    input: {
      agent: "support",
      ticket:
        "A shopper forgot the password on a personal account and cannot sign in. The reset page still opens. They want the usual steps to choose a new password. No payment or storefront outage is involved.",
    },
    output: {
      decision: "handle_normally",
    },
    metadata: {
      case_id: "case-C",
      case_type: "HELP",
      graded_fields: ["decision"],
    },
  },
];

export function renderPrompt(
  agent: AgentName,
  ticket: string,
  includeMemory: boolean,
): { system: string; user: string } {
  const template = agent === "support" ? SUPPORT_SYSTEM_PROMPT : TRIAGE_SYSTEM_PROMPT;
  const memory = includeMemory ? MEMORY : "";
  const system = template.replaceAll("{{MEMORY}}", memory).trimEnd();
  const user = memory.length === 0 ? ticket : `${ticket}\n\n${memory}`;
  return { system, user };
}
