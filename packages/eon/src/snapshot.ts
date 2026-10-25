import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveExistingPath } from "@memeval/repo-paths";

import { getEonAccessToken, redactKnownSecrets } from "./auth";
import { connectorUrl, eonFetch, EonHttpError } from "./client";
import { normalizeConnectorName, readEonConfig } from "./config";

const DEFAULT_MAX_RECORDS = 100;
const MAX_FIRST_PAGE_RECORDS = 100;
const SHOW_MANY_CHUNK_SIZE = 100;

type ConnectorSearchConfig = {
  path: `/${string}`;
  queryParameter: string;
  perPageParameter: string;
  recordsKey: string;
  nextPageKey: string;
  directLookup: {
    path: `/${string}`;
    idsParameter: string;
    recordsKey: string;
  };
};

const CONNECTOR_SEARCH_CONFIGS = {
  zendesk: {
    path: "/api/v2/search.json",
    queryParameter: "query",
    perPageParameter: "per_page",
    recordsKey: "results",
    nextPageKey: "next_page",
    directLookup: {
      path: "/api/v2/tickets/show_many.json",
      idsParameter: "ids",
      recordsKey: "tickets",
    },
  },
} as const satisfies Record<string, ConnectorSearchConfig>;

type SupportedConnector = keyof typeof CONNECTOR_SEARCH_CONFIGS;

type SnapshotFile = {
  connector: string;
  fileName: string;
  recordCount: number;
};

export async function writeSnapshot(
  connector: string,
  query: string,
  options: { maxRecords?: number } = {},
): Promise<SnapshotFile> {
  const name = normalizeConnectorName(connector);
  const searchQuery = query.trim();
  if (!searchQuery) throw new Error("Search query must not be empty.");
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) {
    throw new Error("--max-records must be a positive integer.");
  }

  const search = connectorSearchConfig(name);
  const config = readEonConfig();
  const base = connectorUrl(config.baseTemplate, name, "/");
  const firstUrl = connectorUrl(config.baseTemplate, name, search.path);
  firstUrl.searchParams.set(search.queryParameter, searchQuery);
  firstUrl.searchParams.set(
    search.perPageParameter,
    String(Math.min(maxRecords, MAX_FIRST_PAGE_RECORDS)),
  );
  const visited = new Set<string>();
  const records: unknown[] = [];
  let nextUrl: URL | null = firstUrl;

  while (nextUrl && records.length < maxRecords) {
    assertSafePageUrl(nextUrl, base.origin);
    const pageKey = nextUrl.toString();
    if (visited.has(pageKey)) {
      throw new Error("Search pagination loop detected in next_page.");
    }
    visited.add(pageKey);

    const response = await eonFetch(name, `${nextUrl.pathname}${nextUrl.search}`, { method: "GET" });
    const payload = await readJsonResponse(response);
    const pageRecords = isRecord(payload) ? payload[search.recordsKey] : undefined;
    if (!Array.isArray(pageRecords)) {
      throw new Error(
        `Search response did not contain a ${search.recordsKey} record array.`,
      );
    }
    records.push(...pageRecords.slice(0, maxRecords - records.length));

    nextUrl = nextPage(payload, search, base.origin);
  }

  return persistSnapshot(name, searchQuery, records, config.dayState);
}

export async function writeSnapshotByIds(
  connector: string,
  idsFile: string,
): Promise<SnapshotFile> {
  const name = normalizeConnectorName(connector);
  const search = connectorSearchConfig(name);
  const resolvedIdsFile = resolveExistingPath(idsFile, {
    from: import.meta.url,
    label: "IDs file",
  });
  const ids = parseSnapshotTicketIds(await readFile(resolvedIdsFile, "utf8"));
  if (ids.length === 0) {
    throw new Error(
      `No ticket IDs found in ${path.basename(resolvedIdsFile)}. Add one ID per line; blank and # comment lines are ignored. No network request was made.`,
    );
  }

  const recordsById = new Map<string, unknown>();
  for (let start = 0; start < ids.length; start += SHOW_MANY_CHUNK_SIZE) {
    const chunk = ids.slice(start, start + SHOW_MANY_CHUNK_SIZE);
    const query = new URLSearchParams({
      [search.directLookup.idsParameter]: chunk.join(","),
    });
    const response = await eonFetch(
      name,
      `${search.directLookup.path}?${query.toString()}`,
      { method: "GET" },
    );
    const payload = await readJsonResponse(response, "Direct lookup");
    const rows = isRecord(payload) ? payload[search.directLookup.recordsKey] : undefined;
    if (!Array.isArray(rows)) {
      throw new Error(
        `Direct lookup response did not contain a ${search.directLookup.recordsKey} record array.`,
      );
    }

    const requested = new Set(chunk);
    for (const row of rows) {
      if (!isRecord(row)) {
        throw new Error("Direct lookup response contained a malformed ticket record.");
      }
      const id = responseTicketId(row.id);
      if (!requested.has(id)) {
        throw new Error(`Direct lookup response contained unexpected ticket ID "${id}".`);
      }
      if (recordsById.has(id)) {
        throw new Error(`Direct lookup response contained duplicate ticket ID "${id}".`);
      }
      recordsById.set(id, row);
    }
  }

  const missing = ids.filter((id) => !recordsById.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Direct lookup did not resolve all requested tickets. Missing IDs: ${missing.join(", ")}. No snapshot was written.`,
    );
  }

  const config = readEonConfig();
  const records = ids.map((id) => recordsById.get(id));
  return persistSnapshot(name, path.basename(resolvedIdsFile), records, config.dayState);
}

function parseSnapshotTicketIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const id = line.trim();
    if (!id || id.startsWith("#")) continue;
    if (!/^[1-9]\d*$/.test(id)) {
      throw new Error(
        `Invalid ticket ID "${id}". IDs must be positive decimal integers, one per line.`,
      );
    }
    if (seen.has(id)) duplicates.add(id);
    else {
      seen.add(id);
      ids.push(id);
    }
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate ticket IDs are not allowed: ${[...duplicates].join(", ")}.`);
  }
  return ids;
}

function responseTicketId(value: unknown): string {
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  throw new Error("Direct lookup response contained a malformed ticket ID.");
}

async function persistSnapshot(
  connector: string,
  query: string,
  records: unknown[],
  dayState: string | undefined,
): Promise<SnapshotFile> {
  const auth = await getEonAccessToken(connector);
  const fetchedAt = new Date().toISOString();
  const fileName = `${fetchedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`;
  const directory = path.join(fixturesRoot(), connector);
  await mkdir(directory, { recursive: true });
  const document = {
    tenant: auth.tenant,
    connector,
    dayState: dayState ?? null,
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
  return { connector, fileName, recordCount: records.length };
}

function connectorSearchConfig(connector: string): ConnectorSearchConfig {
  if (!Object.hasOwn(CONNECTOR_SEARCH_CONFIGS, connector)) {
    throw new Error(
      `Unsupported connector "${connector}". Supported connectors: ${Object.keys(CONNECTOR_SEARCH_CONFIGS).join(", ")}.`,
    );
  }
  return CONNECTOR_SEARCH_CONFIGS[connector as SupportedConnector];
}

function nextPage(
  payload: unknown,
  search: ConnectorSearchConfig,
  expectedOrigin: string,
): URL | null {
  const value = isRecord(payload) ? payload[search.nextPageKey] : undefined;
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new Error(`Search response ${search.nextPageKey} must be a URL or null.`);
  }
  let url: URL;
  try {
    url = new URL(value, expectedOrigin);
  } catch {
    throw new Error("Search response next_page was not a valid URL.");
  }
  assertSafePageUrl(url, expectedOrigin);
  return url;
}

function assertSafePageUrl(url: URL, expectedOrigin: string): void {
  if (url.protocol !== "https:" || url.origin !== expectedOrigin || url.username || url.password) {
    throw new Error("Refusing next_page outside the expected connector HTTPS origin.");
  }
}

async function readJsonResponse(response: Response, label = "Search"): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    await response.body?.cancel();
    throw new Error(`${label} response was not JSON. content-type: ${contentType || "<absent>"}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} response was not valid JSON.`);
  }
}

function fixturesRoot(): string {
  return fileURLToPath(new URL("../fixtures", import.meta.url));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CliOptions =
  | { mode: "search"; connector: string; query: string; maxRecords: number }
  | { mode: "ids"; connector: string; idsFile: string };

function parseCli(args: string[]): CliOptions | undefined {
  const connector = args.shift();
  if (connector?.startsWith("--")) {
    throw new Error("Connector positional argument is required before options.");
  }
  const queryParts: string[] = [];
  let maxRecords = DEFAULT_MAX_RECORDS;
  let hasMaxRecords = false;
  let idsFile: string | undefined;
  while (args.length > 0) {
    const item = args.shift();
    if (item === "--max-records") {
      if (hasMaxRecords) throw new Error("--max-records may only be specified once.");
      const raw = args.shift();
      if (!raw || !/^[1-9]\d*$/.test(raw)) throw new Error("--max-records must be a positive integer.");
      maxRecords = Number(raw);
      if (!Number.isSafeInteger(maxRecords)) throw new Error("--max-records must be a positive integer.");
      hasMaxRecords = true;
    } else if (item === "--ids") {
      if (idsFile !== undefined) throw new Error("--ids may only be specified once.");
      const raw = args.shift();
      if (!raw || raw.startsWith("--")) throw new Error("--ids requires a file path.");
      idsFile = raw;
    } else if (item?.startsWith("--")) {
      throw new Error(`Unknown option: ${item}`);
    } else if (item) {
      queryParts.push(item);
    }
  }
  const query = queryParts.join(" ").trim();
  if (!connector) return undefined;
  if (idsFile !== undefined) {
    if (query) throw new Error("A search query cannot be combined with --ids.");
    if (hasMaxRecords) {
      throw new Error("--max-records cannot be combined with --ids; ID mode fetches every requested ID.");
    }
    return { mode: "ids", connector, idsFile };
  }
  return query ? { mode: "search", connector, query, maxRecords } : undefined;
}

async function runCli(): Promise<void> {
  try {
    const parsed = parseCli(process.argv.slice(2));
    if (!parsed) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    const written = parsed.mode === "ids"
      ? await writeSnapshotByIds(parsed.connector, parsed.idsFile)
      : await writeSnapshot(parsed.connector, parsed.query, {
        maxRecords: parsed.maxRecords,
      });
    console.log(`Wrote ${written.recordCount} records to fixtures/${written.connector}/${written.fileName}`);
  } catch (error) {
    if (error instanceof EonHttpError) console.error(error.message);
    else console.error(error instanceof Error ? error.message : "Snapshot failed.");
    process.exitCode = 1;
  }
}

function printUsage(): void {
  console.error("Usage:");
  console.error("  bun run snapshot -- <connector> <search query> [--max-records N]");
  console.error("  bun run snapshot -- <connector> --ids <file>");
  console.error("  connector: supported connector name");
  console.error('  search query: non-empty query; quote queries containing spaces (for example, "type:ticket status:open")');
  console.error("  --ids file: one positive decimal ticket ID per line; blank and # comment lines are ignored");
}

function isCliEntry(): boolean {
  const meta = import.meta as ImportMeta & { main?: boolean };
  if (typeof meta.main === "boolean") return meta.main;
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isCliEntry()) await runCli();
