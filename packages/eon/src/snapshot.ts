import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getEonAccessToken, redactKnownSecrets } from "./auth";
import { connectorUrl, eonFetch, EonHttpError } from "./client";
import { normalizeConnectorName, readEonConfig } from "./config";

const DEFAULT_MAX_RECORDS = 100;
const MAX_FIRST_PAGE_RECORDS = 100;

type ConnectorSearchConfig = {
  path: `/${string}`;
  queryParameter: string;
  perPageParameter: string;
  recordsKey: string;
  nextPageKey: string;
};

const CONNECTOR_SEARCH_CONFIGS = {
  zendesk: {
    path: "/api/v2/search.json",
    queryParameter: "query",
    perPageParameter: "per_page",
    recordsKey: "results",
    nextPageKey: "next_page",
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

  const auth = await getEonAccessToken(name);
  const fetchedAt = new Date().toISOString();
  const fileName = `${fetchedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`;
  const directory = path.join(fixturesRoot(), name);
  await mkdir(directory, { recursive: true });
  const document = {
    tenant: auth.tenant,
    connector: name,
    dayState: config.dayState ?? null,
    fetchedAt,
    query: searchQuery,
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

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    await response.body?.cancel();
    throw new Error(`Search response was not JSON. content-type: ${contentType || "<absent>"}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("Search response was not valid JSON.");
  }
}

function fixturesRoot(): string {
  return fileURLToPath(new URL("../fixtures", import.meta.url));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCli(args: string[]): { connector: string; query: string; maxRecords: number } | undefined {
  const connector = args.shift();
  const queryParts: string[] = [];
  let maxRecords = DEFAULT_MAX_RECORDS;
  while (args.length > 0) {
    const item = args.shift();
    if (item === "--max-records") {
      const raw = args.shift();
      if (!raw || !/^[1-9]\d*$/.test(raw)) throw new Error("--max-records must be a positive integer.");
      maxRecords = Number(raw);
      if (!Number.isSafeInteger(maxRecords)) throw new Error("--max-records must be a positive integer.");
    } else if (item?.startsWith("--")) {
      throw new Error(`Unknown option: ${item}`);
    } else if (item) {
      queryParts.push(item);
    }
  }
  const query = queryParts.join(" ").trim();
  return connector && query ? { connector, query, maxRecords } : undefined;
}

async function runCli(): Promise<void> {
  try {
    const parsed = parseCli(process.argv.slice(2));
    if (!parsed) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    const written = await writeSnapshot(parsed.connector, parsed.query, {
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
  console.error("Usage: bun run snapshot -- <connector> <search-query> [--max-records N]");
  console.error("  connector: supported connector name");
  console.error('  search-query: non-empty query; quote queries containing spaces (for example, "type:ticket status:open")');
}

function isCliEntry(): boolean {
  const meta = import.meta as ImportMeta & { main?: boolean };
  if (typeof meta.main === "boolean") return meta.main;
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isCliEntry()) await runCli();
