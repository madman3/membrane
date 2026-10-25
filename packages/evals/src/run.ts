import { INSTRUMENTATION_PROJECT, tracerProvider } from "./instrumentation";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@arizeai/phoenix-client";
import { createDataset, getDataset } from "@arizeai/phoenix-client/datasets";
import { asExperimentEvaluator, runExperiment } from "@arizeai/phoenix-client/experiments";
import { getSpans } from "@arizeai/phoenix-client/spans";
import type { Example, ExampleWithId } from "@arizeai/phoenix-client/types/datasets";
import type {
  ExperimentEvaluationRun,
  ExperimentRun,
  RanExperiment,
} from "@arizeai/phoenix-client/types/experiments";
import { getExperimentUrl } from "@arizeai/phoenix-client/utils/urlUtils";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPETITIONS,
  deriveDatasetName,
  loadDecisionExamples,
  renderPrompt,
  type AgentName,
  type CaseType,
} from "./cases";
import { readEvalConfig } from "./config";
import { decisionOutputFormat, decisionSchema, type Decision } from "./decision";
import { EVALUATOR_NAME, gradeDecision, isCaseType } from "./grade";
import {
  decideVerdict,
  verdictBranch,
  type Verdict,
  type VerdictBranch,
} from "./verdict";

const USAGE =
  "Usage: bun run eval:run [--cases <directory-or-csv>]\n" +
  "CSV inputs load memory.txt from the CSV file's parent directory.";

function parseCliArgs(args: string[]): { casesPath?: string } {
  let casesPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--cases") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`--cases requires a path.\n${USAGE}`);
      }
      if (casesPath !== undefined) {
        throw new Error(`--cases may only be specified once.\n${USAGE}`);
      }
      casesPath = value;
      index += 1;
    } else if (argument.startsWith("--cases=")) {
      const value = argument.slice("--cases=".length);
      if (!value) throw new Error(`--cases requires a path.\n${USAGE}`);
      if (casesPath !== undefined) {
        throw new Error(`--cases may only be specified once.\n${USAGE}`);
      }
      casesPath = value;
    } else {
      throw new Error(`Unknown argument: ${argument || "(empty)"}.\n${USAGE}`);
    }
  }
  return casesPath === undefined ? {} : { casesPath };
}

const cli = parseCliArgs(process.argv.slice(2));
const loaded = await loadDecisionExamples(cli.casesPath);
const config = readEvalConfig();
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
const client = createClient({ options: { baseUrl: config.phoenixBaseUrl } });
const caseIds = loaded.examples.map((example) => example.id);
const datasetName = deriveDatasetName(loaded.sourcePath, loaded.sourceType, caseIds);

function normalizePreview(value: string, limit?: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return limit === undefined ? normalized : Array.from(normalized).slice(0, limit).join("");
}

function ticketDetails(ticket: string, caseId: string): { subject: string; description: string } {
  const match = /^Subject: (.*)\nDescription: ([\s\S]*)$/u.exec(ticket);
  if (!match) throw new Error(`Case ${caseId} has malformed fixture ticket text.`);
  const subject = match[1];
  const description = match[2];
  if (subject === undefined || description === undefined) {
    throw new Error(`Case ${caseId} lacks fixture subject or description.`);
  }
  return { subject, description };
}

for (const example of loaded.examples.filter((item) => item.metadata.preview === true)) {
  const { subject, description } = ticketDetails(example.input.ticket, example.id);
  console.log(`Untrusted ticket preview (${example.id}):`);
  console.log(`Subject [untrusted]: ${normalizePreview(subject)}`);
  console.log(`Description [untrusted, first 200 chars]: ${normalizePreview(description, 200)}`);
}

async function findOrCreateDataset(): Promise<{ datasetId: string }> {
  try {
    const existing = await getDataset({
      client,
      dataset: { datasetName },
    });
    console.log(`Reusing real-fixture dataset ${existing.name} (${existing.id}).`);
    return { datasetId: existing.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes(`Dataset with name ${datasetName} not found`)) throw error;
  }
  console.log(`Creating real-fixture dataset ${datasetName}.`);
  return createDataset({
    client,
    name: datasetName,
    description: "Decision and memory verdict cases resolved from the checked-in Eon Zendesk fixture.",
    examples: loaded.examples,
  });
}

const datasetRef = await findOrCreateDataset();
const dataset = await getDataset({ client, dataset: datasetRef });
assertDatasetCases(dataset.examples, new Set(caseIds));

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
    throw new Error("MALFORMED: example input.ticket must be non-empty.");
  }
  return { agent, ticket };
}

function replyText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function requireCompletedReply(message: Anthropic.Message): string {
  const stopReason = message.stop_reason ?? "unknown";
  if (stopReason === "max_tokens" || stopReason === "refusal") {
    throw new Error(`MALFORMED: incomplete reply (stop_reason=${stopReason}).`);
  }
  const text = replyText(message);
  if (text.trim().length === 0) {
    throw new Error(`MALFORMED: empty reply (stop_reason=${stopReason}).`);
  }
  if (stopReason !== "end_turn") {
    throw new Error(`MALFORMED: unexpected stop_reason=${stopReason}.`);
  }
  return text;
}

function isRateLimit(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 429 || status === 529;
}

async function callClaude(example: Example, memory: string): Promise<unknown> {
  const { agent, ticket } = ticketInput(example);
  const prompt = renderPrompt(agent, ticket, memory);
  let message: Anthropic.Message | undefined;
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
      if (!isRateLimit(error) || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  if (!message) throw lastError instanceof Error ? lastError : new Error("Claude request failed.");
  const text = requireCompletedReply(message);
  try {
    return decisionOutputFormat.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid structured output";
    throw new Error(`MALFORMED: decision parse failed. ${detail}`);
  }
}

type RecordedTask = {
  task: (example: Example) => Promise<Decision>;
  decisions: Map<string, Array<Decision | undefined>>;
};

function createRecordedTask(memory: string): RecordedTask {
  const decisions = new Map(
    caseIds.map((caseId) => [caseId, new Array<Decision | undefined>(REPETITIONS)]),
  );
  const nextRepetition = new Map(caseIds.map((caseId) => [caseId, 0]));

  const task = async (example: Example): Promise<Decision> => {
    const caseId = example.metadata?.case_id;
    if (typeof caseId !== "string" || !decisions.has(caseId)) {
      throw new Error("MALFORMED: task example has an unknown case_id.");
    }
    // Phoenix queues each case's repetitions in ascending order, but returns runs in
    // completion order. Reserve the slot synchronously before the model call so the
    // persisted decisions retain stable repetition order.
    const repetitionIndex = nextRepetition.get(caseId) ?? 0;
    nextRepetition.set(caseId, repetitionIndex + 1);
    if (repetitionIndex >= REPETITIONS) {
      throw new Error(`MALFORMED: case ${caseId} exceeded ${REPETITIONS} repetitions.`);
    }

    const output = await callClaude(example, memory);
    const parsed = decisionSchema.safeParse(output);
    if (!parsed.success) {
      throw new Error(`MALFORMED: case ${caseId} returned an unparsed decision.`);
    }
    decisions.get(caseId)?.splice(repetitionIndex, 1, parsed.data);
    return parsed.data;
  };

  return { task, decisions };
}

const controlTask = createRecordedTask("");
const treatmentTask = createRecordedTask(loaded.memory);

function experimentUrl(experiment: RanExperiment): string {
  return getExperimentUrl({
    baseUrl: config.phoenixBaseUrl,
    datasetId: experiment.datasetId,
    experimentId: experiment.id,
  });
}

function exampleGlobalId(example: ExampleWithId): string {
  return example.nodeId ?? example.id;
}

function caseIdOf(example: ExampleWithId): string {
  const value = example.metadata?.case_id;
  if (typeof value !== "string" || !caseIds.includes(value)) {
    throw new Error(`Dataset example ${example.id} has an unknown case_id.`);
  }
  return value;
}

function caseTypeOf(example: ExampleWithId): CaseType {
  const value = example.metadata?.case_type;
  if (!isCaseType(value)) throw new Error(`Dataset example ${example.id} has an invalid case_type.`);
  return value;
}

function agentOf(example: ExampleWithId): AgentName {
  const value = example.metadata?.agent;
  if (value !== "support" && value !== "triage") {
    throw new Error(`Dataset example ${example.id} has an invalid agent.`);
  }
  return value;
}

type RunOutcome = "pass" | "fail" | "malformed";

function outcomeFor(
  run: ExperimentRun,
  evaluation: ExperimentEvaluationRun | undefined,
): RunOutcome {
  if (run.error?.startsWith("MALFORMED:")) return "malformed";
  if (run.error) return "fail";
  if (!evaluation || evaluation.error || !evaluation.result) return "malformed";
  if (evaluation.result.label === "malformed" || evaluation.result.score == null) return "malformed";
  if (!decisionSchema.safeParse(run.output).success) return "malformed";
  return evaluation.result.label === "pass" && evaluation.result.score >= 1 ? "pass" : "fail";
}

function runsFor(experiment: RanExperiment): Map<string, RunOutcome[]> {
  const examples = new Map(dataset.examples.map((example) => [exampleGlobalId(example), example]));
  const evaluations = new Map(
    (experiment.evaluationRuns ?? [])
      .filter((evaluation) => evaluation.name === EVALUATOR_NAME)
      .map((evaluation) => [evaluation.experimentRunId, evaluation]),
  );
  const grouped = new Map(caseIds.map((caseId) => [caseId, [] as RunOutcome[]]));
  for (const run of Object.values(experiment.runs)) {
    const example = examples.get(run.datasetExampleId);
    if (!example) throw new Error(`Experiment run ${run.id} has no dataset example.`);
    grouped.get(caseIdOf(example))?.push(outcomeFor(run, evaluations.get(run.id)));
  }
  return grouped;
}

function infrastructureErrors(experiment: RanExperiment): string[] {
  return Object.values(experiment.runs).flatMap((run) =>
    run.error && !run.error.startsWith("MALFORMED:") ? [run.error] : [],
  );
}

const runAt = new Date().toISOString();
const stamp = runAt.replace(/[:.]/g, "-");
console.log(`Running ${caseIds.length} real-fixture decision cases with model ${config.model}.`);

const control = await runExperiment({
  client,
  dataset: { datasetId: dataset.id },
  experimentName: `real-eon-control-${stamp}`,
  experimentDescription: "Real Eon fixture cases with empty memory.",
  experimentMetadata: { condition: "control", fixture: "eon-zendesk", model: config.model },
  task: controlTask.task,
  evaluators: [decisionFields],
  repetitions: REPETITIONS,
});

const treatment = await runExperiment({
  client,
  dataset: { datasetId: dataset.id },
  experimentName: `real-eon-treatment-${stamp}`,
  experimentDescription: "Real Eon fixture cases with file-backed memory appended last.",
  experimentMetadata: { condition: "treatment", fixture: "eon-zendesk", model: config.model },
  task: treatmentTask.task,
  evaluators: [decisionFields],
  repetitions: REPETITIONS,
});

const controlUrl = experimentUrl(control);
const treatmentUrl = experimentUrl(treatment);
console.log(`Control experiment: ${controlUrl}`);
console.log(`Treatment experiment: ${treatmentUrl}`);

const infraErrors = [...new Set([...infrastructureErrors(control), ...infrastructureErrors(treatment)])];
if (infraErrors.length > 0) throw new Error(infraErrors.join("\n"));

const controlOutcomes = runsFor(control);
const treatmentOutcomes = runsFor(treatment);
const countsByAgent = new Map<AgentName, Record<Verdict, number>>();
const firedBranches = new Set<VerdictBranch>();
type CaseResultBase = {
  id: string;
  agent: AgentName;
  ticketId: string;
  caseType: CaseType;
  ticketSubject: string;
  ticketDescription: string;
  expected: Record<string, unknown>;
  gradedFields: string[];
  controlPasses: number;
  treatmentPasses: number;
  verdict: Verdict;
  verdictReason: string;
};
const caseResults: CaseResultBase[] = [];
let anyMalformed = false;

for (const caseId of caseIds) {
  const controlRuns = controlOutcomes.get(caseId) ?? [];
  const treatmentRuns = treatmentOutcomes.get(caseId) ?? [];
  const example = dataset.examples.find((item) => caseIdOf(item) === caseId);
  if (!example) throw new Error(`Dataset is missing case ${caseId}.`);
  const caseType = caseTypeOf(example);
  const agent = agentOf(example);
  const controlPasses = controlRuns.filter((outcome) => outcome === "pass").length;
  const treatmentPasses = treatmentRuns.filter((outcome) => outcome === "pass").length;
  const malformed =
    controlRuns.length !== REPETITIONS ||
    treatmentRuns.length !== REPETITIONS ||
    [...controlRuns, ...treatmentRuns].some((outcome) => outcome === "malformed");
  anyMalformed ||= malformed;
  const result = decideVerdict({ caseType, controlPasses, treatmentPasses, malformed });
  const counts = countsByAgent.get(agent) ?? {
    PASS: 0,
    FAIL: 0,
    INSUFFICIENT: 0,
    NEUTRAL: 0,
    INCONCLUSIVE: 0,
  };
  counts[result.verdict] += 1;
  countsByAgent.set(agent, counts);
  firedBranches.add(verdictBranch({ ...result, caseType }));
  const loadedExample = loaded.examples.find((item) => item.id === caseId);
  if (!loadedExample) throw new Error(`Loaded fixtures are missing case ${caseId}.`);
  const ticket = ticketDetails(loadedExample.input.ticket, caseId);
  caseResults.push({
    id: caseId,
    agent,
    ticketId: loadedExample.input.ticket_id,
    caseType,
    ticketSubject: ticket.subject,
    ticketDescription: ticket.description,
    expected: loadedExample.output,
    gradedFields: [...loadedExample.metadata.graded_fields],
    controlPasses,
    treatmentPasses,
    verdict: result.verdict,
    verdictReason: result.reason,
  });
  console.log(
    `${caseId} / ${agent} / ${caseType}: control ${controlPasses}/${REPETITIONS} -> treatment ${treatmentPasses}/${REPETITIONS} = ${result.verdict} (${result.reason})`,
  );
}

for (const agent of ["support", "triage"] as const) {
  const counts = countsByAgent.get(agent);
  if (counts) {
    console.log(
      `Summary ${agent}: PASS ${counts.PASS}, FAIL ${counts.FAIL}, INSUFFICIENT ${counts.INSUFFICIENT}, NEUTRAL ${counts.NEUTRAL}, INCONCLUSIVE ${counts.INCONCLUSIVE}`,
    );
  }
}

await tracerProvider.forceFlush();

type RecordedSpan = {
  name: string;
  span_kind: string;
  parent_id?: string | null;
  context?: { span_id?: string; trace_id?: string };
  attributes?: Record<string, unknown>;
};

function traceIds(experiment: RanExperiment): string[] {
  return Object.values(experiment.runs)
    .map((run) => run.traceId)
    .filter((id): id is string => typeof id === "string" && !/^0+$/.test(id));
}

function attributeNumber(attributes: Record<string, unknown> | undefined, key: string): number | null {
  const value = attributes?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function isValidLlmChild(span: RecordedSpan, parentId: string): boolean {
  return (
    span.span_kind === "LLM" &&
    span.parent_id === parentId &&
    typeof span.attributes?.["llm.model_name"] === "string" &&
    (attributeNumber(span.attributes, "llm.token_count.prompt") ?? 0) > 0 &&
    (attributeNumber(span.attributes, "llm.token_count.completion") ?? 0) > 0
  );
}

async function spansInProject(projectName: string, ids: string[]): Promise<RecordedSpan[]> {
  const spans: RecordedSpan[] = [];
  let cursor: string | null = null;
  do {
    const page = await getSpans({
      client,
      project: { projectName },
      traceIds: ids,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    spans.push(...page.spans);
    cursor = page.nextCursor;
  } while (cursor);
  return spans;
}

async function spansForExperiment(experiment: RanExperiment): Promise<RecordedSpan[]> {
  const output: RecordedSpan[] = [];
  for (const projectName of [experiment.projectName, INSTRUMENTATION_PROJECT]) {
    if (!projectName) continue;
    try {
      output.push(...(await spansInProject(projectName, traceIds(experiment))));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/not found|404/i.test(message)) throw error;
    }
  }
  return output;
}

function spanEvidence(spans: RecordedSpan[], expectedTasks: number): boolean {
  const tasks = spans.filter((span) => span.span_kind === "CHAIN" && span.name.startsWith("Task:"));
  const uniqueTasks = new Map(tasks.map((task) => [task.context?.span_id, task]));
  uniqueTasks.delete(undefined);
  return (
    uniqueTasks.size === expectedTasks &&
    [...uniqueTasks.keys()].every(
      (spanId) => typeof spanId === "string" && spans.some((span) => isValidLlmChild(span, spanId)),
    )
  );
}

async function loadSpans(experiment: RanExperiment): Promise<RecordedSpan[]> {
  const expected = Object.keys(experiment.runs).length;
  let spans: RecordedSpan[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    spans = await spansForExperiment(experiment);
    if (spanEvidence(spans, expected)) return spans;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return spans;
}

function tokenTotals(spans: RecordedSpan[]): { prompt: number; completion: number } {
  const taskIds = new Set(
    spans
      .filter((span) => span.span_kind === "CHAIN" && span.name.startsWith("Task:"))
      .map((span) => span.context?.span_id)
      .filter((id): id is string => typeof id === "string"),
  );
  const seen = new Set<string>();
  let prompt = 0;
  let completion = 0;
  for (const span of spans) {
    const spanId = span.context?.span_id;
    if (
      span.span_kind !== "LLM" ||
      !spanId ||
      !span.parent_id ||
      !taskIds.has(span.parent_id) ||
      seen.has(spanId)
    ) {
      continue;
    }
    seen.add(spanId);
    prompt += attributeNumber(span.attributes, "llm.token_count.prompt") ?? 0;
    completion += attributeNumber(span.attributes, "llm.token_count.completion") ?? 0;
  }
  return { prompt, completion };
}

const controlSpans = await loadSpans(control);
const treatmentSpans = await loadSpans(treatment);
const controlTokens = tokenTotals(controlSpans);
const treatmentTokens = tokenTotals(treatmentSpans);
console.log(
  `Tokens: control prompt=${controlTokens.prompt} completion=${controlTokens.completion}; treatment prompt=${treatmentTokens.prompt} completion=${treatmentTokens.completion}`,
);

const controlSpanOk = spanEvidence(controlSpans, Object.keys(control.runs).length);
const treatmentSpanOk = spanEvidence(treatmentSpans, Object.keys(treatment.runs).length);
if (!controlSpanOk || !treatmentSpanOk) {
  throw new Error(
    `LLM child span assertion failed (control=${controlSpanOk}, treatment=${treatmentSpanOk}).`,
  );
}
if (anyMalformed) process.exitCode = 2;
const branchOrder = [
  "PASS-helped",
  "PASS-no-harm",
  "FAIL-worse",
  "FAIL-flip",
  "INSUFFICIENT",
  "NEUTRAL",
  "INCONCLUSIVE",
] as const satisfies readonly VerdictBranch[];
console.log(`Verdict branches fired: ${branchOrder.filter((label) => firedBranches.has(label)).join(", ")}`);

type ResultArtifactCase = CaseResultBase & {
  controlDecisions: Decision[];
  treatmentDecisions: Decision[];
};

type ResultArtifact = {
  memory: string;
  model: string;
  effort: "medium";
  runAt: string;
  repetitions: number;
  phoenix: {
    datasetId: string;
    controlExperimentId: string;
    treatmentExperimentId: string;
  };
  byAgent: Record<
    string,
    { pass: number; fail: number; insufficient: number; neutral: number; inconclusive: number }
  >;
  cases: ResultArtifactCase[];
};

function requireRecordedDecisions(
  recorded: Map<string, Array<Decision | undefined>>,
  caseId: string,
  arm: "control" | "treatment",
): Decision[] {
  const slots = recorded.get(caseId);
  const decisions: Decision[] = [];
  for (let index = 0; index < REPETITIONS; index += 1) {
    const decision = slots?.[index];
    if (!decision) {
      // Never invent a decision for a malformed task run. The artifact contract
      // requires five real parsed decisions, so an incomplete artifact is not written.
      throw new Error(
        `${arm} case ${caseId} has no parsed decision for repetition ${index + 1}/${REPETITIONS}`,
      );
    }
    decisions.push(decision);
  }
  if (slots?.length !== REPETITIONS) {
    throw new Error(`${arm} case ${caseId} recorded ${slots?.length ?? 0} decision slots`);
  }
  return decisions;
}

async function writeResultArtifact(artifact: ResultArtifact): Promise<{
  latestPath: string;
  timestampedPath: string;
}> {
  const resultsDirectory = fileURLToPath(new URL("../results", import.meta.url));
  await mkdir(resultsDirectory, { recursive: true });
  const contents = `${JSON.stringify(artifact, null, 2)}\n`;
  const safeTimestamp = artifact.runAt.replace(/[:.]/gu, "-");
  const timestampedPath = path.join(
    resultsDirectory,
    `${safeTimestamp}-${randomUUID()}.json`,
  );
  const latestPath = path.join(resultsDirectory, "latest.json");
  const temporaryLatestPath = path.join(
    resultsDirectory,
    `.latest-${process.pid}-${randomUUID()}.tmp`,
  );

  await writeFile(timestampedPath, contents, { encoding: "utf8", flag: "wx" });
  try {
    await writeFile(temporaryLatestPath, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporaryLatestPath, latestPath);
  } finally {
    await rm(temporaryLatestPath, { force: true });
  }
  return { latestPath, timestampedPath };
}

let artifactCases: ResultArtifactCase[] | undefined;
try {
  artifactCases = caseResults.map((result) => ({
    ...result,
    controlDecisions: requireRecordedDecisions(controlTask.decisions, result.id, "control"),
    treatmentDecisions: requireRecordedDecisions(treatmentTask.decisions, result.id, "treatment"),
  }));
} catch (error) {
  if (!anyMalformed) throw error;
  const detail = error instanceof Error ? error.message : "missing parsed decisions";
  console.error(`Result artifact not written: ${detail}.`);
}

if (artifactCases) {
  const byAgent = Object.fromEntries(
    [...countsByAgent.entries()].map(([agent, counts]) => [
      agent,
      {
        pass: counts.PASS,
        fail: counts.FAIL,
        insufficient: counts.INSUFFICIENT,
        neutral: counts.NEUTRAL,
        inconclusive: counts.INCONCLUSIVE,
      },
    ]),
  );
  const written = await writeResultArtifact({
    memory: loaded.memory,
    model: config.model,
    effort: "medium",
    runAt,
    repetitions: REPETITIONS,
    phoenix: {
      datasetId: dataset.id,
      controlExperimentId: control.id,
      treatmentExperimentId: treatment.id,
    },
    byAgent,
    cases: artifactCases,
  });
  console.log(`Result artifacts: ${written.latestPath} and ${written.timestampedPath}`);
}

function assertDatasetCases(examples: ExampleWithId[], expectedIds: Set<string>): void {
  const actual = new Set(
    examples.map((example) => {
      const value = example.metadata?.case_id;
      return typeof value === "string" ? value : "";
    }),
  );
  if (actual.size !== expectedIds.size || [...expectedIds].some((id) => !actual.has(id))) {
    throw new Error(
      `Dataset ${datasetName} exists with different cases; use a new dataset name to preserve history.`,
    );
  }
}
