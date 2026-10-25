import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverConnector, formatHeaders, redactKnownSecrets } from "./auth";
import { connectorRequest } from "./client";
import { applyBaseTemplate, normalizeConnectorName, readEonConfig } from "./config";

const OPENAPI_RELS = new Set(["service-desc", "service-doc", "describedby"]);
const SEARCH_RELS = new Set(["search", "list"]);
const URL_KEYS = new Set([
  "openapi",
  "openapi_url",
  "openapiurl",
  "spec_url",
  "specurl",
  "swagger",
  "service-desc",
  "servicedesc",
  "service_desc",
  "resource_documentation",
  "resourcedocumentation",
]);
const PAGINATION = new Set([
  "limit",
  "offset",
  "page",
  "pagesize",
  "page_size",
  "per_page",
  "perpage",
  "cursor",
  "skip",
  "take",
  "count",
  "sort",
  "order",
  "orderby",
  "order_by",
]);

export type LinkValue = {
  href: string;
  rel: string;
  type?: string;
};

export type SearchOperation = {
  path: string;
  queryParameter: string;
};

type AttemptNote = {
  document?: Record<string, unknown>;
  note: string;
  source: string;
};

export function schemaFile(connector: string): string {
  const name = normalizeConnectorName(connector);
  return path.join(packageRoot(), "schema", `${name}.json`);
}

export async function readStoredOpenApi(connector: string): Promise<unknown | undefined> {
  const name = normalizeConnectorName(connector);
  try {
    const text = await readFile(schemaFile(name), "utf8");
    return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new Error(`Stored schema/${name}.json could not be read as JSON.`);
  }
}

export async function fetchOpenApiDocument(
  connector: string,
): Promise<{ document: Record<string, unknown>; source: string }> {
  const name = normalizeConnectorName(connector);
  const discovery = await discoverConnector(name);
  const base = applyBaseTemplate(readEonConfig().baseTemplate, name);
  const response = await connectorRequest(name, "/");
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  const notes = [
    `Authenticated GET / HTTP ${response.status}. content-type: ${contentType || "<absent>"}. ${formatHeaders(response.headers)}`,
    `Unauthenticated probe HTTP ${discovery.unauthorizedStatus}. ${headerLine(discovery.unauthorizedHeaders)}`,
    `Protected resource metadata keys: ${discovery.resourceMetadataKeys.join(", ") || "<none>"}.`,
  ];

  let parsed: unknown;
  if (shouldParseJson(contentType, body)) {
    parsed = tryParse(body);
    if (parsed === undefined) notes.push("GET / body was not JSON.");
    else notes.push(`GET / top-level keys: ${topLevelKeys(parsed)}.`);
  } else {
    notes.push("GET / body was not JSON.");
  }

  if (isOpenApiDocument(parsed)) return { document: parsed, source: "GET /" };

  const links = [
    ...parseLinkHeader(response.headers.get("link")),
    ...linkHeaderFromRecord(discovery.unauthorizedHeaders),
    ...collectReferences(parsed),
  ];
  if (discovery.resourceDocumentation) {
    links.push({ href: discovery.resourceDocumentation, rel: "service-doc" });
  }

  for (const link of openApiLinks(links)) {
    const loaded = await loadAdvertised(name, base, link.href);
    notes.push(loaded.note);
    if (loaded.document) return { document: loaded.document, source: loaded.source };
  }

  throw new Error(`Connector did not advertise an OpenAPI document. ${notes.join(" ")}`);
}

export function isOpenApiDocument(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const version = value.openapi ?? value.swagger;
  return typeof version === "string" && /^\d+\.\d+/.test(version) && (isRecord(value.paths) || isRecord(value.info));
}

export function parseLinkHeader(header: string | null): LinkValue[] {
  if (!header) return [];
  const links: LinkValue[] = [];
  let index = 0;
  while (index < header.length) {
    while (index < header.length && (isSpace(header[index] ?? "") || header[index] === ",")) index += 1;
    if (index >= header.length || header[index] !== "<") break;
    const start = index + 1;
    index = header.indexOf(">", start);
    if (index < 0) break;
    const href = header.slice(start, index);
    index += 1;
    const params: Record<string, string> = {};
    while (index < header.length && header[index] !== ",") {
      while (index < header.length && (isSpace(header[index] ?? "") || header[index] === ";")) index += 1;
      if (index >= header.length || header[index] === ",") break;
      const keyStart = index;
      while (index < header.length && isTokenChar(header[index] ?? "")) index += 1;
      const key = header.slice(keyStart, index).toLowerCase();
      while (index < header.length && isSpace(header[index] ?? "")) index += 1;
      if (header[index] !== "=") continue;
      index += 1;
      while (index < header.length && isSpace(header[index] ?? "")) index += 1;
      const parsed = readQuotedOrToken(header, index);
      if (key) params[key] = parsed.value;
      index = parsed.index;
    }
    links.push({ href, rel: params.rel ?? "", ...(params.type ? { type: params.type } : {}) });
  }
  return links;
}

export function collectReferences(value: unknown): LinkValue[] {
  const found: LinkValue[] = [];
  const seen = new Set<unknown>();
  walkReferences(value, found, seen, 0);
  return found;
}

export function findSearchOperation(document: unknown, origin?: string): SearchOperation | undefined {
  if (!isRecord(document) || !isRecord(document.paths)) return undefined;
  let best: (SearchOperation & { score: number }) | undefined;
  for (const [rawPath, item] of Object.entries(document.paths)) {
    if (rawPath.includes("{") || !isRecord(item) || !isRecord(item.get)) continue;
    const names = parameterNames(document, item, item.get);
    const queryParameter = chooseQueryParameter(names);
    if (!queryParameter) continue;
    const qualified = applyServerPrefix(document, rawPath, origin);
    if (!qualified || qualified.includes("{")) continue;
    const described = `${rawPath} ${String(item.get.operationId ?? "")} ${String(item.get.summary ?? "")}`.toLowerCase();
    let score = 0;
    if (described.includes("search")) score += 5;
    if (described.includes("list")) score += 3;
    if (described.includes("query")) score += 1;
    const rank = rankName(queryParameter);
    if (rank === 0) score += 4;
    else if (rank === 1) score += 2;
    if (score <= 0 || (best && score <= best.score)) continue;
    best = { path: qualified, queryParameter, score };
  }
  return best ? { path: best.path, queryParameter: best.queryParameter } : undefined;
}

export function describeOperations(document: unknown): string {
  if (!isRecord(document) || !isRecord(document.paths)) return "<no paths>";
  const lines: string[] = [];
  for (const [operationPath, item] of Object.entries(document.paths)) {
    if (!isRecord(item)) continue;
    for (const method of ["get", "head", "post", "put", "patch", "delete"]) {
      if (!isRecord(item[method])) continue;
      const names = parameterNames(document, item, item[method]);
      const suffix = names.length > 0 ? ` query=${names.join(",")}` : "";
      lines.push(`${method.toUpperCase()} ${operationPath}${suffix}`);
      if (lines.length >= 40) return lines.join("; ");
    }
  }
  return lines.join("; ") || "<no operations>";
}

export function referenceSearch(href: string): SearchOperation | undefined {
  const template = href.match(/\{\?([^{}]+)\}/);
  let names = template?.[1]?.split(",").map((part) => part.trim()).filter((part) => part.length > 0) ?? [];
  const bare = href.split("{")[0] ?? href;
  let pathname = bare;
  if (bare.startsWith("https://") || bare.startsWith("http://")) {
    try {
      const url = new URL(bare);
      pathname = url.pathname;
      if (names.length === 0) names = [...url.searchParams.keys()];
    } catch {
      return undefined;
    }
  } else if (bare.includes("?")) {
    const [pathPart, query] = bare.split("?");
    pathname = pathPart && pathPart.length > 0 ? pathPart : "/";
    if (names.length === 0 && query) names = [...new URLSearchParams(query).keys()];
  }
  const queryParameter = chooseQueryParameter(names);
  if (!queryParameter || pathname.includes("{")) return undefined;
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return { path: normalized.split("?")[0] ?? normalized, queryParameter };
}

export function chooseQueryParameter(names: readonly string[]): string | undefined {
  const searchable = names.filter((name) => !PAGINATION.has(name.toLowerCase()));
  const best = searchable[0];
  const second = searchable[1];
  if (!best) return undefined;
  if (!second) return best;
  const ranked = [...searchable].sort((left, right) => rankName(left) - rankName(right));
  const winner = ranked[0];
  const runner = ranked[1];
  if (!winner || !runner || rankName(winner) === rankName(runner)) return undefined;
  return winner;
}

export function shouldParseJson(contentType: string, body: string): boolean {
  const type = contentType.toLowerCase();
  if (type.includes("html") || (type.includes("xml") && !type.includes("json"))) return false;
  if (type.includes("json")) return true;
  const trimmed = body.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export function topLevelKeys(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (!isRecord(value)) return typeof value;
  return Object.keys(value).join(", ") || "<none>";
}

export function hasRel(link: LinkValue, rels: ReadonlySet<string>): boolean {
  return link.rel.split(/\s+/).some((part) => rels.has(part.toLowerCase()));
}

export { SEARCH_RELS };

function openApiLinks(links: LinkValue[]): LinkValue[] {
  const seen = new Set<string>();
  const chosen: LinkValue[] = [];
  for (const link of links) {
    const type = link.type?.toLowerCase() ?? "";
    if (!hasRel(link, OPENAPI_RELS) && !type.includes("openapi")) continue;
    if (seen.has(link.href)) continue;
    seen.add(link.href);
    chosen.push(link);
    if (chosen.length >= 8) break;
  }
  return chosen;
}

async function loadAdvertised(connector: string, base: URL, href: string): Promise<AttemptNote> {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return { note: "An advertised URL was not valid.", source: "advertised URL" };
  }
  const source = `${url.origin}${url.pathname}`;
  if (url.username || url.password || url.protocol !== "https:") {
    return { note: `${source} was not an https URL.`, source };
  }
  if (url.origin !== base.origin) {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json, */*;q=0.1" },
      signal: AbortSignal.timeout(30_000),
    });
    return readDocument(response, source);
  }
  const response = await connectorRequest(connector, `${url.pathname}${url.search}`);
  return readDocument(response, source);
}

async function readDocument(response: Response, source: string): Promise<AttemptNote> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("html")) {
    await response.body?.cancel();
    return { note: `${source} HTTP ${response.status} content-type: ${contentType}.`, source };
  }
  const body = await response.text();
  if (!response.ok || !shouldParseJson(contentType, body)) {
    return {
      note: `${source} HTTP ${response.status} content-type: ${contentType || "<absent>"}.`,
      source,
    };
  }
  const parsed = tryParse(body);
  if (isOpenApiDocument(parsed)) return { document: parsed, note: `${source} is an OpenAPI document.`, source };
  return { note: `${source} HTTP ${response.status} JSON keys: ${topLevelKeys(parsed)}.`, source };
}

function walkReferences(value: unknown, found: LinkValue[], seen: Set<unknown>, depth: number): void {
  if (depth > 6 || value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) walkReferences(item, found, seen, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.href === "string" && typeof record.rel === "string") {
    found.push({ href: record.href, rel: record.rel, ...(typeof record.type === "string" ? { type: record.type } : {}) });
  }
  const links = record._links;
  if (isRecord(links)) {
    for (const [rel, link] of Object.entries(links)) {
      if (typeof link === "string") found.push({ href: link, rel });
      else if (isRecord(link) && typeof link.href === "string") {
        found.push({
          href: link.href,
          rel,
          ...(typeof link.type === "string" ? { type: link.type } : {}),
        });
      }
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === "_links") continue;
    if (typeof child === "string" && URL_KEYS.has(key.toLowerCase()) && isHttpReference(child)) {
      found.push({ href: child, rel: "service-desc" });
    }
    walkReferences(child, found, seen, depth + 1);
  }
}

function applyServerPrefix(document: Record<string, unknown>, operationPath: string, origin?: string): string | undefined {
  const servers = document.servers;
  const server = Array.isArray(servers) ? servers[0] : undefined;
  if (!isRecord(server) || typeof server.url !== "string" || server.url.includes("{")) return operationPath;
  if (server.url.startsWith("/")) return joinPath(server.url, operationPath);
  if (server.url.startsWith("https://")) {
    try {
      const serverUrl = new URL(server.url);
      if (origin && serverUrl.origin !== origin) return undefined;
      return new URL(operationPath.replace(/^\//, ""), server.url.endsWith("/") ? server.url : `${server.url}/`).pathname;
    } catch {
      return undefined;
    }
  }
  return operationPath;
}

function parameterNames(document: unknown, pathItem: Record<string, unknown>, operation: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const bucket of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      const parameter = resolveNode(document, entry, 0);
      if (!isRecord(parameter) || parameter.in !== "query" || typeof parameter.name !== "string") continue;
      names.push(parameter.name);
    }
  }
  return names;
}

function resolveNode(document: unknown, node: unknown, depth: number): unknown {
  if (depth > 8 || !isRecord(node) || typeof node.$ref !== "string" || !node.$ref.startsWith("#/")) return node;
  const parts = node.$ref
    .slice(2)
    .split("/")
    .map((part) => decodePointer(part));
  let current: unknown = document;
  for (const part of parts) {
    if (!isRecord(current) || !(part in current)) return node;
    current = current[part];
  }
  return resolveNode(document, current, depth + 1);
}

function decodePointer(part: string): string {
  try {
    return decodeURIComponent(part.replaceAll("~1", "/").replaceAll("~0", "~"));
  } catch {
    return part;
  }
}

function rankName(name: string): number {
  const lower = name.toLowerCase();
  if (lower === "q" || lower === "query" || lower === "search") return 0;
  if (lower.includes("query") || lower.includes("search") || lower === "text") return 1;
  return 2;
}

function joinPath(prefix: string, operationPath: string): string {
  return `${prefix.replace(/\/$/, "")}/${operationPath.replace(/^\//, "")}`;
}

function linkHeaderFromRecord(headers: Readonly<Record<string, string>>): LinkValue[] {
  const header = headers.link ?? headers.Link;
  return header ? parseLinkHeader(header) : [];
}

function headerLine(headers: Readonly<Record<string, string>>): string {
  const entries = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
  if (!("www-authenticate" in headers)) entries.unshift("www-authenticate: <absent>");
  return entries.join(" | ");
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
  } catch {
    return undefined;
  }
}

function readQuotedOrToken(source: string, index: number): { value: string; index: number } {
  if (source[index] === '"') {
    let value = "";
    let cursor = index + 1;
    while (cursor < source.length) {
      const char = source[cursor] ?? "";
      if (char === "\\") {
        value += source[cursor + 1] ?? "";
        cursor += 2;
        continue;
      }
      if (char === '"') return { value, index: cursor + 1 };
      value += char;
      cursor += 1;
    }
    return { value, index: cursor };
  }
  const start = index;
  let cursor = index;
  while (cursor < source.length && isTokenChar(source[cursor] ?? "")) cursor += 1;
  return { value: source.slice(start, cursor), index: cursor };
}

function isHttpReference(value: string): boolean {
  return value.startsWith("https://") || value.startsWith("/") || value.startsWith("./");
}

function isTokenChar(char: string): boolean {
  return /[!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(char);
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
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
  if (!connector || process.argv.length > 3) {
    console.error("Usage: bun run openapi -- <connector>");
    process.exitCode = 1;
    return;
  }
  try {
    const name = normalizeConnectorName(connector);
    const fetched = await fetchOpenApiDocument(name);
    const file = schemaFile(name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${redactKnownSecrets(JSON.stringify(fetched.document, null, 2))}\n`, "utf8");
    console.log(`Wrote OpenAPI document to schema/${name}.json (${fetched.source}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "OpenAPI fetch failed.");
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
