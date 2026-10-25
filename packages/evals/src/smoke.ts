import { INSTRUMENTATION_PROJECT, tracerProvider } from "./instrumentation";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@arizeai/phoenix-client";
import { createDataset, getDataset } from "@arizeai/phoenix-client/datasets";
import {
  asExperimentEvaluator,
  runExperiment,
} from "@arizeai/phoenix-client/experiments";
import { getSpans } from "@arizeai/phoenix-client/spans";
import type { Example, ExampleWithId } from "@arizeai/phoenix-client/types/datasets";
import type {
  ExperimentEvaluationRun,
  ExperimentRun,
  RanExperiment,
} from "@arizeai/phoenix-client/types/experiments";
import { getExperimentUrl } from "@arizeai/phoenix-client/utils/urlUtils";

import {
  CASE_IDS,
  DATASET_NAME,
  REPETITIONS,
  decisionExamples,
  renderPrompt,
  type AgentName,
  type CaseId,
  type CaseType,
} from "./cases";
import { readEvalConfig } from "./config";
import { decisionOutputFormat, decisionSchema } from "./decision";
import { EVALUATOR_NAME, gradeDecision, isCaseType } from "./grade";
import { decideVerdict, type Verdict } from "./verdict";

const MESSAGES_API_BASE_URL = "https://api.anthropic.com";

function redactHeaderValue(name: string, value: string): string {
  const lower = name.toLowerCase();
  if (lower === "authorization" || lower === "x-api-key") {
    return "[redacted]";
  }
  return value;
}

const config = readEvalConfig();
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: MESSAGES_API_BASE_URL,
  fetch: async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const reported: Record<string, string> = {};
    for (const [name, value] of headers.entries()) {
      reported[name] = redactHeaderValue(name, value);
    }
    console.log(`Messages API request: POST ${url}`);
    console.log(`Messages API headers: ${JSON.stringify(reported)}`);
    return fetch(input, init);
  },
});
const client = createClient({
  options: { baseUrl: config.phoenixBaseUrl },
});

async function findOrCreateDataset(): Promise<{ datasetId: string }> {
  try {
    const existing = await getDataset({
      client,
      dataset: { datasetName: DATASET_NAME },
    });
    console.log(`Reusing fabricated dataset ${existing.name} (${existing.id}).`);
    return { datasetId: existing.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes(`Dataset with name ${DATASET_NAME} not found`)) {
      throw error;
    }
  }

  console.log(`Creating fabricated dataset ${DATASET_NAME}.`);
  return createDataset({
    client,
    name: DATASET_NAME,
    description:
      "Fabricated support tickets for a local decision-verdict experiment. These tickets are generic placeholders.",
    examples: decisionExamples,
  });
}

const datasetRef = await findOrCreateDataset();
const dataset = await getDataset({ client, dataset: datasetRef });

const decisionFields = asExperimentEvaluator({
  name: EVALUATOR_NAME,
  kind: "CODE",
  evaluate: ({ output, expected, metadata }) => gradeDecision({ output, expected, metadata }),
});

function ticketInput(example: Example): { agent: AgentName; ticket: string } {
  const agent = example.input.agent;
  const ticket = example.input.ticket;
  if (agent !== "support" && agent !== "triage") {
    throw new Error("MALFORMED: example input.agent must be support or triage.");
  }
  if (typeof ticket !== "string" || ticket.trim().length === 0) {
    throw new Error("MALFORMED: example input.ticket must be a non-empty string.");
  }
  return { agent, ticket };
}

function replyText(message: Anthropic.Message): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function requireCompletedReply(message: Anthropic.Message): string {
  const stopReason = message.stop_reason ?? "unknown";
  if (stopReason === "max_tokens" || stopReason === "refusal") {
    throw new Error(
      `MALFORMED: Claude stopped with stop_reason=${stopReason}. The reply is not a completed answer.`,
    );
  }
  const text = replyText(message);
  if (text.trim().length === 0) {
    throw new Error(`MALFORMED: Claude returned no text (stop_reason=${stopReason}).`);
  }
  if (stopReason !== "end_turn") {
    throw new Error(
      `MALFORMED: Claude stopped with stop_reason=${stopReason}. Expected end_turn with text.`,
    );
  }
  return text;
}

function isRateLimit(error: unknown): boolean {
  if (typeof error !== "object" || error == null || !("status" in error)) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return status === 429 || status === 529;
}

async function callClaude(example: Example, includeMemory: boolean): Promise<unknown> {
  const { agent, ticket } = ticketInput(example);
  const prompt = renderPrompt(agent, ticket, includeMemory);
  let message: Anthropic.Message | null = null;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      message = await anthropic.messages.create({
        model: config.model,
        max_tokens: 1024,
        output_config: {
          effort: "medium",
          format: decisionOutputFormat,
        },
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      });
      break;
    } catch (error) {
      lastError = error;
      if (!isRateLimit(error) || attempt === 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  if (!message) {
    throw lastError instanceof Error ? lastError : new Error("Claude request failed.");
  }
  const text = requireCompletedReply(message);
  try {
    return decisionOutputFormat.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid decision";
    throw new Error(
      `MALFORMED: Claude returned text that is not a valid decision (stop_reason=${message.stop_reason ?? "unknown"}). ${detail}`,
    );
  }
}

async function controlTask(example: Example): Promise<unknown> {
  return callClaude(example, false);
}

async function treatmentTask(example: Example): Promise<unknown> {
  return callClaude(example, true);
}

function experimentUrl(experiment: RanExperiment): string {
  return getExperimentUrl({
    baseUrl: config.phoenixBaseUrl,
    datasetId: experiment.datasetId,
    experimentId: experiment.id,
  });
}

function traceIds(experiment: RanExperiment): string[] {
  return Object.values(experiment.runs)
    .map((run) => run.traceId)
    .filter((traceId): traceId is string => typeof traceId === "string" && !/^0+$/.test(traceId));
}

type RecordedSpan = {
  name: string;
  span_kind: string;
  parent_id?: string | null;
  context?: { span_id?: string; trace_id?: string };
  attributes?: Record<string, unknown>;
};

function attributeNumber(attributes: Record<string, unknown> | undefined, key: string): number | null {
  const value = attributes?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function modelName(attributes: Record<string, unknown> | undefined): string | null {
  const value = attributes?.["llm.model_name"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isTaskSpan(span: RecordedSpan): boolean {
  return span.span_kind === "CHAIN" && span.name.startsWith("Task:");
}

function isLlmChild(span: RecordedSpan, taskSpanId: string): boolean {
  if (span.span_kind !== "LLM" || span.parent_id !== taskSpanId) {
    return false;
  }
  const inputTokens = attributeNumber(span.attributes, "llm.token_count.prompt");
  const outputTokens = attributeNumber(span.attributes, "llm.token_count.completion");
  return modelName(span.attributes) != null && (inputTokens ?? 0) > 0 && (outputTokens ?? 0) > 0;
}

async function spansInProject(projectName: string, ids: string[]): Promise<RecordedSpan[]> {
  const collected: RecordedSpan[] = [];
  let cursor: string | null = null;
  do {
    const page = await getSpans({
      client,
      project: { projectName },
      traceIds: ids,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    collected.push(...page.spans);
    cursor = page.nextCursor;
  } while (cursor);
  return collected;
}

async function spansForExperiment(experiment: RanExperiment, ids: string[]): Promise<RecordedSpan[]> {
  const projectNames = [experiment.projectName, INSTRUMENTATION_PROJECT].filter(
    (projectName): projectName is string => projectName != null && projectName.length > 0,
  );
  const collected: RecordedSpan[] = [];
  for (const projectName of projectNames) {
    try {
      collected.push(...(await spansInProject(projectName, ids)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/not found|404/i.test(message)) {
        throw error;
      }
    }
  }
  return collected;
}

function taskSpansOf(spans: RecordedSpan[]): RecordedSpan[] {
  const seen = new Set<string>();
  const taskSpans: RecordedSpan[] = [];
  for (const span of spans) {
    if (!isTaskSpan(span)) {
      continue;
    }
    const spanId = span.context?.span_id;
    if (spanId) {
      if (seen.has(spanId)) {
        continue;
      }
      seen.add(spanId);
    }
    taskSpans.push(span);
  }
  return taskSpans;
}

function spanEvidence(
  label: string,
  spans: RecordedSpan[],
  expectedTasks: number,
): { ok: boolean; line: string } {
  const taskSpans = taskSpansOf(spans);
  const missing: string[] = [];
  let withChild = 0;
  for (const taskSpan of taskSpans) {
    const taskSpanId = taskSpan.context?.span_id;
    if (!taskSpanId || !spans.some((span) => isLlmChild(span, taskSpanId))) {
      missing.push(`${taskSpan.name}${taskSpanId ? ` (${taskSpanId})` : ""}`);
      continue;
    }
    withChild += 1;
  }
  const ok = expectedTasks > 0 && taskSpans.length === expectedTasks && missing.length === 0;
  const line = ok
    ? `${label}: ${withChild}/${expectedTasks} task spans have an LLM child with a model name and non-zero input and output tokens`
    : `${label}: ${withChild}/${expectedTasks} task spans have an LLM child (${taskSpans.length} task spans found). Missing: ${missing.join(", ") || "task span count does not match the runs"}. A task span with no LLM child is a failure.`;
  return { ok, line };
}

function tokenTotals(spans: RecordedSpan[]): { prompt: number; completion: number } {
  const seen = new Set<string>();
  let prompt = 0;
  let completion = 0;
  for (const span of spans) {
    if (span.span_kind !== "LLM") {
      continue;
    }
    const spanId = span.context?.span_id;
    if (!spanId || seen.has(spanId)) {
      continue;
    }
    seen.add(spanId);
    prompt += attributeNumber(span.attributes, "llm.token_count.prompt") ?? 0;
    completion += attributeNumber(span.attributes, "llm.token_count.completion") ?? 0;
  }
  return { prompt, completion };
}

function exampleGlobalId(example: ExampleWithId): string {
  return example.nodeId ?? example.id;
}

function caseIdOf(example: ExampleWithId): CaseId {
  const fromMetadata = example.metadata?.case_id;
  const candidate = typeof fromMetadata === "string" ? fromMetadata : example.id;
  if (candidate === "case-A" || candidate === "case-B" || candidate === "case-C") {
    return candidate;
  }
  throw new Error(`Dataset example ${example.id} is not case-A, case-B, or case-C.`);
}

function caseTypeOf(example: ExampleWithId): CaseType {
  const caseType = example.metadata?.case_type;
  if (!isCaseType(caseType)) {
    throw new Error(`Dataset example ${example.id} is missing case_type HELP or HARM_CHECK.`);
  }
  return caseType;
}

type RunOutcome = "pass" | "fail" | "malformed";

function outcomeFor(
  run: ExperimentRun,
  evaluation: ExperimentEvaluationRun | undefined,
): RunOutcome {
  if (run.error?.startsWith("MALFORMED:")) {
    return "malformed";
  }
  if (run.error) {
    return "fail";
  }
  if (!evaluation || evaluation.error) {
    return "malformed";
  }
  const result = evaluation.result;
  if (!result || result.label === "malformed" || result.score == null) {
    return "malformed";
  }
  const parsed = decisionSchema.safeParse(run.output);
  if (!parsed.success) {
    return "malformed";
  }
  return result.score >= 1 && result.label !== "fail" ? "pass" : "fail";
}

function runsFor(experiment: RanExperiment): Map<CaseId, RunOutcome[]> {
  const examplesById = new Map(dataset.examples.map((example) => [exampleGlobalId(example), example]));
  const evaluations = new Map(
    (experiment.evaluationRuns ?? [])
      .filter((evaluation) => evaluation.name === EVALUATOR_NAME)
      .map((evaluation) => [evaluation.experimentRunId, evaluation]),
  );
  const grouped = new Map<CaseId, RunOutcome[]>(CASE_IDS.map((caseId) => [caseId, []]));
  for (const run of Object.values(experiment.runs)) {
    const example = examplesById.get(run.datasetExampleId);
    if (!example) {
      throw new Error(`Experiment run ${run.id} has no dataset example ${run.datasetExampleId}.`);
    }
    const outcomes = grouped.get(caseIdOf(example));
    if (!outcomes) {
      throw new Error(`Experiment run ${run.id} is not one of the fabricated cases.`);
    }
    outcomes.push(outcomeFor(run, evaluations.get(run.id)));
  }
  return grouped;
}

function infrastructureErrors(experiment: RanExperiment): string[] {
  return Object.values(experiment.runs).flatMap((run) =>
    run.error && !run.error.startsWith("MALFORMED:") ? [run.error] : [],
  );
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

console.log("Running fabricated decision cases. These tickets are synthetic local placeholders.");

const control = await runExperiment({
  client,
  dataset: { datasetId: dataset.id },
  experimentName: `synthetic-decision-control-${stamp}`,
  experimentDescription: "Fabricated decision cases with the memory placeholder left empty.",
  experimentMetadata: { condition: "control", synthetic: true, model: config.model },
  task: controlTask,
  evaluators: [decisionFields],
  repetitions: REPETITIONS,
});

const treatment = await runExperiment({
  client,
  dataset: { datasetId: dataset.id },
  experimentName: `synthetic-decision-treatment-${stamp}`,
  experimentDescription:
    "Fabricated decision cases with the memory string appended after the system prompt and ticket.",
  experimentMetadata: { condition: "treatment", synthetic: true, model: config.model },
  task: treatmentTask,
  evaluators: [decisionFields],
  repetitions: REPETITIONS,
});

const controlUrl = experimentUrl(control);
const treatmentUrl = experimentUrl(treatment);
console.log(`Smoke summary: model=${config.model}`);
console.log(`Control experiment: ${controlUrl}`);
console.log(`Treatment experiment: ${treatmentUrl}`);

const infraErrors = [...new Set([...infrastructureErrors(control), ...infrastructureErrors(treatment)])];
if (infraErrors.length > 0) {
  throw new Error(infraErrors.join("\n"));
}

const controlOutcomes = runsFor(control);
const treatmentOutcomes = runsFor(treatment);
const verdicts: Verdict[] = [];
let anyMalformed = false;

for (const caseId of CASE_IDS) {
  const controlRuns = controlOutcomes.get(caseId) ?? [];
  const treatmentRuns = treatmentOutcomes.get(caseId) ?? [];
  const example = dataset.examples.find((item) => caseIdOf(item) === caseId);
  if (!example) {
    throw new Error(`Fabricated dataset is missing ${caseId}.`);
  }
  const caseType = caseTypeOf(example);
  const controlPasses = controlRuns.filter((outcome) => outcome === "pass").length;
  const treatmentPasses = treatmentRuns.filter((outcome) => outcome === "pass").length;
  const malformed =
    controlRuns.length !== REPETITIONS ||
    treatmentRuns.length !== REPETITIONS ||
    [...controlRuns, ...treatmentRuns].some((outcome) => outcome === "malformed");
  anyMalformed = anyMalformed || malformed;
  const { verdict, reason } = decideVerdict({
    caseType,
    controlPasses,
    treatmentPasses,
    malformed,
  });
  verdicts.push(verdict);
  console.log(
    `${caseId} (${caseType}): control ${controlPasses}/${REPETITIONS} -> treatment ${treatmentPasses}/${REPETITIONS} = ${verdict} (${reason})`,
  );
}

const counts = { PASS: 0, FAIL: 0, NEUTRAL: 0, INCONCLUSIVE: 0 };
for (const verdict of verdicts) {
  counts[verdict] += 1;
}
console.log(
  `Summary: PASS ${counts.PASS}, FAIL ${counts.FAIL}, NEUTRAL ${counts.NEUTRAL}, INCONCLUSIVE ${counts.INCONCLUSIVE}`,
);

await tracerProvider.forceFlush();

async function loadSpans(
  experiment: RanExperiment,
  ids: string[],
  expectedTasks: number,
): Promise<RecordedSpan[]> {
  let spans: RecordedSpan[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    spans = await spansForExperiment(experiment, ids);
    if (spanEvidence("check", spans, expectedTasks).ok) {
      return spans;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return spans;
}

const controlRunCount = Object.keys(control.runs).length;
const treatmentRunCount = Object.keys(treatment.runs).length;
const controlSpans = await loadSpans(control, traceIds(control), controlRunCount);
const treatmentSpans = await loadSpans(treatment, traceIds(treatment), treatmentRunCount);
const controlTokens = tokenTotals(controlSpans);
const treatmentTokens = tokenTotals(treatmentSpans);
console.log(
  `Tokens: control prompt=${controlTokens.prompt} completion=${controlTokens.completion}; treatment prompt=${treatmentTokens.prompt} completion=${treatmentTokens.completion}`,
);

const controlEvidence = spanEvidence("control", controlSpans, controlRunCount);
const treatmentEvidence = spanEvidence("treatment", treatmentSpans, treatmentRunCount);
console.log(controlEvidence.line);
console.log(treatmentEvidence.line);

if ((!controlEvidence.ok || !treatmentEvidence.ok) && !anyMalformed) {
  throw new Error(
    `LLM child span assertion failed. ${controlEvidence.line} ${treatmentEvidence.line}`,
  );
}
if (!controlEvidence.ok || !treatmentEvidence.ok) {
  console.log("Span check incomplete. Malformed runs take precedence for the case verdict.");
}
