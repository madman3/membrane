import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactKnownSecrets } from "./auth";
import { connectorRequest, eonFetch, EonHttpError } from "./client";
import { applyBaseTemplate, normalizeConnectorName, readEonConfig } from "./config";
import {
  SEARCH_RELS,
  collectReferences,
  describeOperations,
  findSearchOperation,
  hasRel,
  isOpenApiDocument,
  parseLinkHeader,
  readStoredOpenApi,
  referenceSearch,
  shouldParseJson,
  topLevelKeys,
  type SearchOperation,
} from "./openapi";

type SnapshotFile = {
  connector: string;
  fileName: string;
  recordCount: number;
};

export async function writeSnapshot(connector: string, query: string): Promise<SnapshotFile> {
  const name = normalizeConnectorName(connector);
  const base = applyBaseTemplate(readEonConfig().baseTemplate, name);
  const operation = await resolveSearch(name, base);
  const params = new URLSearchParams();
  params.set(operation.queryParameter, query);
  const separator = operation.path.includes("?") ? "&" : "?";
  const response = await eonFetch(name, `${operation.path}${separator}${params.toString()}`);
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (!shouldParseJson(contentType, body)) {
    throw new Error(`Search response was not JSON. content-type: ${contentType || "<absent>"}.`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.replace(/^\uFEFF/, "")) as unknown;
  } catch {
    throw new Error("Search response was not JSON.");
  }

  const reportedTenant = findReportedValue(payload, ["tenant"]);
  const dayState = findReportedValue(payload, ["dayState", "day_state", "day-state"]);
  const missing = [
    reportedTenant === undefined ? "tenant" : undefined,
    dayState === undefined ? "dayState" : undefined,
  ].filter((item): item is string => item !== undefined);
  if (missing.length > 0) {
    throw new Error(
      `Connector response did not report ${missing.join(" and ")}. Top-level keys: ${topLevelKeys(payload)}.`,
    );
  }

  const records = findRecords(payload);
  const fetchedAt = new Date().toISOString();
  const fileName = `${fetchedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`;
  const directory = path.join(fixturesRoot(), name);
  await mkdir(directory, { recursive: true });
  const document = {
    tenant: reportedTenant,
    connector: name,
    dayState,
    fetchedAt,
    query,
    recordCount: records.length,
    records,
  };
  await writeFile(
    path.join(directory, fileName),
    `${redactKnownSecrets(JSON.stringify(document, null, 2))}\n`,
    "utf8",
  );
  return { connector: name, fileName, recordCount: records.length };
}

async function resolveSearch(connector: string, base: URL): Promise<SearchOperation> {
  const stored = await readStoredOpenApi(connector);
  if (stored !== undefined) {
    const operation = findSearchOperation(stored, base.origin);
    if (!operation) {
      throw new Error(
        `Stored OpenAPI document does not advertise a GET search or list operation with a query parameter. Operations: ${describeOperations(stored)}.`,
      );
    }
    return operation;
  }
  return discoverLiveSearch(connector, base);
}

async function discoverLiveSearch(connector: string, base: URL): Promise<SearchOperation> {
  const response = await connectorRequest(connector, "/");
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  const linkRels = parseLinkHeader(response.headers.get("link")).map((link) => link.rel || "<none>");
  const challenge = response.headers.get("www-authenticate");
  const notes = [
    `HTTP ${response.status}`,
    `content-type: ${contentType || "<absent>"}`,
    `link rels: ${linkRels.join(", ") || "<none>"}`,
    ...(challenge ? [`www-authenticate: ${redactKnownSecrets(challenge)}`] : []),
  ];
  const parsed = shouldParseJson(contentType, body) ? tryParse(body) : undefined;
  if (parsed === undefined) notes.push("body was not JSON");
  else notes.push(`top-level keys: ${topLevelKeys(parsed)}`);

  if (isOpenApiDocument(parsed)) {
    const operation = findSearchOperation(parsed, base.origin);
    if (operation) return operation;
    notes.push(`operations: ${describeOperations(parsed)}`);
  }

  const matches: SearchOperation[] = [];
  const links = [...parseLinkHeader(response.headers.get("link")), ...collectReferences(parsed)];
  for (const link of links) {
    if (!hasRel(link, SEARCH_RELS)) continue;
    if (isForeign(link.href, base)) {
      notes.push("a search link pointed at another origin");
      continue;
    }
    const operation = referenceSearch(link.href);
    if (operation) matches.push(operation);
    else notes.push(`search link ${safePath(link.href)} did not name a query parameter`);
  }

  const unique = dedupe(matches);
  const only = unique[0];
  if (unique.length === 1 && only) return only;
  if (unique.length > 1) {
    throw new Error(
      `Connector advertised more than one search operation (${unique.map((item) => `${item.path} ${item.queryParameter}`).join("; ")}). ${notes.join(". ")}.`,
    );
  }
  throw new Error(`Connector did not advertise a search operation. ${notes.join(". ")}.`);
}

function findReportedValue(root: unknown, names: readonly string[]): unknown {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const queue: unknown[] = [root];
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && queue.length > 0; depth += 1) {
    const width = queue.length;
    for (let index = 0; index < width; index += 1) {
      const current = queue.shift();
      if (!current || typeof current !== "object" || seen.has(current)) continue;
      seen.add(current);
      if (Array.isArray(current)) {
        queue.push(...current.slice(0, 30));
        continue;
      }
      for (const [key, value] of Object.entries(current)) {
        if (wanted.has(key.toLowerCase()) && value !== undefined && value !== null) return value;
        queue.push(value);
      }
    }
  }
  return undefined;
}

function findRecords(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  const keys = ["results", "items", "records", "data", "matches", "hits", "entries", "value"];
  for (const key of keys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return candidate;
  }
  for (const value of Object.values(payload)) {
    if (!isRecord(value)) continue;
    for (const key of keys) {
      if (key === "value") continue;
      const candidate = value[key];
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return [];
}

function dedupe(operations: SearchOperation[]): SearchOperation[] {
  const seen = new Set<string>();
  const unique: SearchOperation[] = [];
  for (const operation of operations) {
    const key = `${operation.path}?${operation.queryParameter}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(operation);
  }
  return unique;
}

function isForeign(href: string, base: URL): boolean {
  const bare = href.split("{")[0] ?? href;
  if (!bare.startsWith("https://") && !bare.startsWith("http://")) return false;
  try {
    return new URL(bare).origin !== base.origin;
  } catch {
    return true;
  }
}

function safePath(href: string): string {
  const bare = href.split("?")[0]?.split("{")[0] ?? href;
  if (bare.startsWith("https://") || bare.startsWith("http://")) {
    try {
      return new URL(bare).pathname;
    } catch {
      return "<unparsed>";
    }
  }
  return bare;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
  } catch {
    return undefined;
  }
}

function fixturesRoot(): string {
  return fileURLToPath(new URL("../fixtures", import.meta.url));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runCli(): Promise<void> {
  const connector = process.argv[2];
  const query = process.argv.slice(3).join(" ").trim();
  if (!connector || !query) {
    console.error("Usage: bun run snapshot -- <connector> <query>");
    process.exitCode = 1;
    return;
  }
  try {
    const written = await writeSnapshot(connector, query);
    console.log(`Wrote ${written.recordCount} records to fixtures/${written.connector}/${written.fileName}`);
  } catch (error) {
    if (error instanceof EonHttpError) {
      const challenge = error.headers["www-authenticate"];
      console.error(error.message);
      if (challenge) console.error(`www-authenticate: ${challenge}`);
      if (error.body) console.error(error.body.slice(0, 500));
    } else {
      console.error(error instanceof Error ? error.message : "Snapshot failed.");
    }
    process.exitCode = 1;
  }
}

function isCliEntry(): boolean {
  const meta = import.meta as ImportMeta & { main?: boolean };
  if (typeof meta.main === "boolean") return meta.main;
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isCliEntry()) {
  await runCli();
}
