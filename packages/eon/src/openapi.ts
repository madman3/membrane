import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeConnectorName } from "./config";

const PAGINATION_PARAMETERS = new Set([
  "cursor",
  "limit",
  "offset",
  "page",
  "page_size",
  "pagesize",
  "per_page",
  "perpage",
]);

export type SearchOperation = {
  path: string;
  queryParameter: string;
  recordsPath: readonly string[];
  nextPagePath?: readonly string[];
  dayStatePath?: readonly string[];
};

export function schemaFile(connector: string): string {
  return path.join(packageRoot(), "schema", `${normalizeConnectorName(connector)}.json`);
}

export async function readStoredOpenApi(connector: string): Promise<Record<string, unknown>> {
  const name = normalizeConnectorName(connector);
  let text: string;
  try {
    text = await readFile(schemaFile(name), "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(
        `Local OpenAPI schema is missing: schema/${name}.json. Add and validate that file before taking a snapshot.`,
      );
    }
    throw new Error(`Local OpenAPI schema could not be read: schema/${name}.json.`);
  }

  let document: unknown;
  try {
    document = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Local OpenAPI schema is not valid JSON: schema/${name}.json.`);
  }
  if (!isOpenApiDocument(document)) {
    throw new Error(
      `Local schema/${name}.json must be a JSON object with an openapi string and paths object.`,
    );
  }
  return document;
}

export function isOpenApiDocument(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.openapi === "string" && isRecord(value.paths);
}

export function findSearchOperation(
  document: Record<string, unknown>,
  expectedOrigin?: string,
): SearchOperation | undefined {
  if (!isRecord(document.paths)) return undefined;
  let best: (SearchOperation & { score: number }) | undefined;

  for (const [operationPath, pathValue] of Object.entries(document.paths)) {
    const pathItem = resolveNode(document, pathValue);
    if (operationPath.includes("{") || !isRecord(pathItem)) continue;
    const get = resolveNode(document, pathItem.get);
    if (!isRecord(get)) continue;
    const queryParameter = selectQueryParameter(document, pathItem, get);
    if (!queryParameter) continue;
    const responseSchema = successResponseSchema(document, get);
    if (!responseSchema) continue;
    const recordsPath = findSingleArrayPath(document, responseSchema);
    if (!recordsPath) continue;
    const path = applyServerPrefix(document, operationPath, expectedOrigin);
    if (!path) continue;

    const description = `${operationPath} ${String(get.operationId ?? "")} ${String(get.summary ?? "")}`.toLowerCase();
    const score = (description.includes("search") ? 10 : 0)
      + (description.includes("list") ? 3 : 0)
      + (["q", "query", "search"].includes(queryParameter.toLowerCase()) ? 4 : 0);
    if (best && score <= best.score) continue;
    best = {
      path,
      queryParameter,
      recordsPath,
      ...optionalPath("nextPagePath", findNamedPath(document, responseSchema, "nextpage")),
      ...optionalPath("dayStatePath", findNamedPath(document, responseSchema, "daystate")),
      score,
    };
  }

  if (!best) return undefined;
  const { score: _score, ...operation } = best;
  return operation;
}

export function describeOperations(document: Record<string, unknown>): string {
  if (!isRecord(document.paths)) return "<no paths>";
  const operations: string[] = [];
  for (const [operationPath, pathValue] of Object.entries(document.paths)) {
    const pathItem = resolveNode(document, pathValue);
    if (!isRecord(pathItem)) continue;
    for (const method of ["get", "head", "post", "put", "patch", "delete"]) {
      if (isRecord(resolveNode(document, pathItem[method]))) {
        operations.push(`${method.toUpperCase()} ${operationPath}`);
      }
    }
  }
  return operations.join("; ") || "<no operations>";
}

function selectQueryParameter(
  document: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): string | undefined {
  const names: string[] = [];
  for (const parameters of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(parameters)) continue;
    for (const item of parameters) {
      const parameter = resolveNode(document, item);
      if (!isRecord(parameter) || parameter.in !== "query" || typeof parameter.name !== "string") continue;
      if (!PAGINATION_PARAMETERS.has(parameter.name.toLowerCase())) names.push(parameter.name);
    }
  }
  if (names.length === 1) return names[0];
  const preferred = names.filter((name) => ["q", "query", "search"].includes(name.toLowerCase()));
  return preferred.length === 1 ? preferred[0] : undefined;
}

function successResponseSchema(
  document: Record<string, unknown>,
  operation: Record<string, unknown>,
): unknown {
  const responses = resolveNode(document, operation.responses);
  if (!isRecord(responses)) return undefined;
  const key = Object.keys(responses).find((candidate) => /^2\d\d$/.test(candidate))
    ?? Object.keys(responses).find((candidate) => /^2XX$/i.test(candidate));
  if (!key) return undefined;
  const response = resolveNode(document, responses[key]);
  if (!isRecord(response)) return undefined;
  const content = resolveNode(document, response.content);
  if (!isRecord(content)) return undefined;
  const mediaType = content["application/json"]
    ?? Object.entries(content).find(([type]) => type.endsWith("+json"))?.[1];
  const media = resolveNode(document, mediaType);
  return isRecord(media) ? media.schema : undefined;
}

function findSingleArrayPath(
  document: Record<string, unknown>,
  schema: unknown,
): readonly string[] | undefined {
  const candidates: string[][] = [];
  collectPaths(document, schema, [], (node) => node.type === "array" || "items" in node, candidates);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function findNamedPath(
  document: Record<string, unknown>,
  schema: unknown,
  normalizedName: string,
): readonly string[] | undefined {
  const matches: string[][] = [];
  collectPaths(
    document,
    schema,
    [],
    (_node, key) => key !== undefined && normalizeProperty(key) === normalizedName,
    matches,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function collectPaths(
  document: Record<string, unknown>,
  schema: unknown,
  prefix: string[],
  match: (node: Record<string, unknown>, key?: string) => boolean,
  output: string[][],
  depth = 0,
): void {
  if (depth > 8) return;
  const node = resolveNode(document, schema);
  if (!isRecord(node)) return;
  if (match(node, prefix.at(-1))) output.push(prefix);
  const properties = collectProperties(document, node);
  for (const [key, child] of Object.entries(properties)) {
    collectPaths(document, child, [...prefix, key], match, output, depth + 1);
  }
}

function collectProperties(
  document: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const direct = resolveNode(document, schema.properties);
  if (isRecord(direct)) Object.assign(properties, direct);
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      const resolved = resolveNode(document, part);
      if (isRecord(resolved)) Object.assign(properties, collectProperties(document, resolved));
    }
  }
  return properties;
}

function resolveNode(document: Record<string, unknown>, value: unknown): unknown {
  let current = value;
  const seen = new Set<string>();
  for (let depth = 0; depth < 12; depth += 1) {
    if (!isRecord(current) || typeof current.$ref !== "string" || !current.$ref.startsWith("#/")) return current;
    if (seen.has(current.$ref)) return current;
    seen.add(current.$ref);
    let resolved: unknown = document;
    for (const part of current.$ref.slice(2).split("/").map(decodePointer)) {
      if (!isRecord(resolved) || !(part in resolved)) return current;
      resolved = resolved[part];
    }
    current = resolved;
  }
  return current;
}

function applyServerPrefix(
  document: Record<string, unknown>,
  operationPath: string,
  expectedOrigin?: string,
): string | undefined {
  const first = Array.isArray(document.servers) ? document.servers[0] : undefined;
  if (!isRecord(first) || typeof first.url !== "string") return operationPath;
  if (first.url.includes("{")) return undefined;
  if (first.url.startsWith("/")) return joinPath(first.url, operationPath);
  try {
    const server = new URL(first.url);
    if (server.protocol !== "https:" || (expectedOrigin && server.origin !== expectedOrigin)) return undefined;
    return joinPath(server.pathname, operationPath);
  } catch {
    return undefined;
  }
}

function optionalPath<K extends string>(
  key: K,
  value: readonly string[] | undefined,
): { [P in K]?: readonly string[] } {
  return value ? { [key]: value } as { [P in K]?: readonly string[] } : {};
}

function joinPath(left: string, right: string): string {
  return `${left.replace(/\/+$/, "")}/${right.replace(/^\/+/, "")}`;
}

function normalizeProperty(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function decodePointer(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function packageRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

async function runCli(): Promise<void> {
  const connector = process.argv[2];
  if (!connector || process.argv.length !== 3) {
    console.error("Usage: bun run openapi -- <connector>");
    process.exitCode = 1;
    return;
  }
  try {
    const name = normalizeConnectorName(connector);
    await readStoredOpenApi(name);
    console.log(`Validated local OpenAPI document: schema/${name}.json`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Local OpenAPI validation failed.");
    process.exitCode = 1;
  }
}

function isCliEntry(): boolean {
  const meta = import.meta as ImportMeta & { main?: boolean };
  if (typeof meta.main === "boolean") return meta.main;
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isCliEntry()) await runCli();
