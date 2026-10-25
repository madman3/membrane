import {
  applyBaseTemplate,
  canonicalConnectorResource,
  ConfigError,
  normalizeConnectorName,
  readEonConfig,
  type EonConfig,
} from "./config";

const REFRESH_SKEW_MS = 60_000;
const TOKEN_CHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;

type Challenge = {
  scheme: string;
  params: Record<string, string>;
};

type Probe = {
  status: number;
  headers: Headers;
  base: URL;
};

type EndpointRecord = {
  tokenEndpoint: string;
  resource: string;
  scope?: string;
};

type TokenRecord = {
  accessToken: string;
  refreshAtMs: number;
};

export type ConnectorDiscovery = {
  connector: string;
  resource: string;
  unauthorizedStatus: number;
  unauthorizedHeaders: Readonly<Record<string, string>>;
  resourceMetadataKeys: readonly string[];
  resourceDocumentation?: string;
  resourceMetadata: Readonly<Record<string, unknown>>;
};

export class DiscoveryError extends Error {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;

  constructor(message: string, status: number, headers: Headers) {
    const secrets = cachedSecretValues();
    super(redactSensitive(message, secrets));
    this.name = "DiscoveryError";
    this.status = status;
    this.headers = headersToObject(headers, secrets);
  }
}

const endpointCache = new Map<string, EndpointRecord>();
const tokenCache = new Map<string, TokenRecord>();
const discoveryCache = new Map<string, ConnectorDiscovery>();
const pending = new Map<string, Promise<string>>();

export function redactSensitive(value: string, secrets: readonly string[] = []): string {
  let output = value;
  for (const secret of secrets) {
    if (secret.length >= 8) output = output.split(secret).join("[redacted]");
  }
  return output
    .replace(
      /("(?:access_token|refresh_token|id_token|client_secret)"\s*:\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replace(/\b((?:access_token|client_secret)=)[^&\s]+/gi, "$1[redacted]");
}

export function headersToObject(
  headers: Headers,
  secrets: readonly string[] = [],
): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    const hidden = key === "authorization" || key === "cookie" || key === "set-cookie";
    result[key] = hidden ? "[redacted]" : clipHeader(key, redactSensitive(value, secrets));
  });
  return result;
}

export function formatHeaders(headers: Headers, secrets: readonly string[] = []): string {
  const record = headersToObject(headers, secrets);
  const lines = Object.entries(record).map(([key, value]) => `${key}: ${value}`);
  if (!("www-authenticate" in record)) lines.unshift("www-authenticate: <absent>");
  return lines.join(" | ");
}

export function resourceMetadataFromWwwAuthenticate(header: string | null): string | undefined {
  return bearerParams(header).resource_metadata;
}

export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Authorization server issuer must be an https URL without user info, query, or fragment.");
  }
  const suffix = url.pathname.replace(/\/+$/, "");
  const urls = [
    `${url.origin}/.well-known/oauth-authorization-server${suffix}`,
    `${url.origin}/.well-known/openid-configuration${suffix}`,
  ];
  if (suffix) urls.push(`${url.origin}${suffix}/.well-known/openid-configuration`);
  return urls;
}

export function redactKnownSecrets(value: string): string {
  let output = value;
  for (const secret of cachedSecretValues()) {
    if (secret.length >= 8) output = output.split(secret).join("[redacted]");
  }
  return output;
}

export function cachedSecretValues(): string[] {
  const values: string[] = [];
  try {
    values.push(readEonConfig().clientSecret);
  } catch {
    // Missing configuration is reported by ConfigError at the call site.
  }
  for (const entry of tokenCache.values()) values.push(entry.accessToken);
  return values;
}

export async function getAccessToken(
  connector: string,
  options?: { forceRefresh?: boolean },
): Promise<string> {
  const name = normalizeConnectorName(connector);
  const forceRefresh = options?.forceRefresh === true;
  if (forceRefresh) tokenCache.delete(name);
  if (!forceRefresh) {
    const cached = freshToken(name);
    if (cached) return cached;
    const inflight = pending.get(name);
    if (inflight) return inflight;
  }

  const promise = loadToken(name).finally(() => {
    if (pending.get(name) === promise) pending.delete(name);
  });
  if (!forceRefresh) pending.set(name, promise);
  return promise;
}

export async function discoverConnector(connector: string): Promise<ConnectorDiscovery> {
  const name = normalizeConnectorName(connector);
  await getAccessToken(name);
  const discovery = discoveryCache.get(name);
  if (!discovery) {
    throw new Error("Connector discovery did not produce protected resource metadata.");
  }
  return discovery;
}

async function loadToken(connector: string): Promise<string> {
  const cached = freshToken(connector);
  if (cached) return cached;
  let endpoint = endpointCache.get(connector);
  if (!endpoint) {
    endpoint = await discoverEndpoint(connector);
    endpointCache.set(connector, endpoint);
  }
  const issued = await requestToken(endpoint);
  tokenCache.set(connector, issued);
  return issued.accessToken;
}

function freshToken(connector: string): string | undefined {
  const cached = tokenCache.get(connector);
  if (!cached || Date.now() >= cached.refreshAtMs) return undefined;
  return cached.accessToken;
}

// Unauthenticated GET, then RFC 9728 protected resource metadata, then RFC 8414
// authorization server metadata. token_endpoint is taken from that document.
async function discoverEndpoint(connector: string): Promise<EndpointRecord> {
  const config = readEonConfig();
  let probe: Probe | undefined;
  try {
    probe = await probeConnector(config, connector);
    const metadata = await loadResourceMetadata(config, probe);
    const documentation = typeof metadata.resource_documentation === "string"
      ? metadata.resource_documentation
      : undefined;
    discoveryCache.set(connector, {
      connector,
      resource: resourceIdentifier(metadata, config, connector),
      unauthorizedStatus: probe.status,
      unauthorizedHeaders: headersToObject(probe.headers, [config.clientSecret]),
      resourceMetadataKeys: Object.keys(metadata),
      ...(documentation ? { resourceDocumentation: documentation } : {}),
      resourceMetadata: metadata,
    });
    const endpoint = await tokenEndpointFor(metadata, probe, config);
    return {
      tokenEndpoint: endpoint,
      resource: resourceIdentifier(metadata, config, connector),
      scope: requestedScope(probe.headers.get("www-authenticate"), metadata),
    };
  } catch (error) {
    if (error instanceof DiscoveryError || error instanceof ConfigError) throw error;
    const message = error instanceof Error ? error.message : "Discovery failed.";
    const secrets = [config.clientSecret];
    if (!probe) {
      throw new DiscoveryError(redactSensitive(message, secrets), 0, new Headers());
    }
    throw new DiscoveryError(
      `${redactSensitive(message, secrets)} ${probeSummary(probe, secrets)}`,
      probe.status,
      probe.headers,
    );
  }
}

async function probeConnector(config: EonConfig, connector: string): Promise<Probe> {
  const base = applyBaseTemplate(config.baseTemplate, connector);
  const response = await fetchDocument(base);
  const finalUrl = safeUrl(response.url) ?? base;
  if (finalUrl.origin !== base.origin) {
    await response.body?.cancel();
    throw httpFailure("Unauthenticated connector request left the connector origin", response, undefined, {
      status: response.status,
      headers: response.headers,
      base,
    }, config);
  }
  await response.body?.cancel();
  return { status: response.status, headers: response.headers, base };
}

async function loadResourceMetadata(config: EonConfig, probe: Probe): Promise<Record<string, unknown>> {
  const header = probe.headers.get("www-authenticate");
  const advertised = resourceMetadataFromWwwAuthenticate(header);
  if (header?.toLowerCase().includes("resource_metadata")) {
    if (!advertised) {
      throw new DiscoveryError(
        `WWW-Authenticate resource_metadata could not be parsed. ${probeSummary(probe, [config.clientSecret])}`,
        probe.status,
        probe.headers,
      );
    }
    const advertisedMetadata = await readResourceMetadata(
      resolveHttps(advertised, probe.base, "resource_metadata"),
      probe,
      config,
      false,
    );
    if (!advertisedMetadata) {
      throw new DiscoveryError(
        `Protected resource metadata was empty. ${probeSummary(probe, [config.clientSecret])}`,
        probe.status,
        probe.headers,
      );
    }
    return advertisedMetadata;
  }

  const attempts: string[] = [];
  for (const candidate of protectedResourceMetadataUrls(probe.base)) {
    const metadata = await readResourceMetadata(candidate, probe, config, true, attempts);
    if (metadata) return metadata;
  }

  throw new DiscoveryError(
    `WWW-Authenticate did not include resource_metadata, and protected resource metadata was not found. ${attempts.join(" || ")} ${probeSummary(probe, [config.clientSecret])}`,
    probe.status,
    probe.headers,
  );
}

async function readResourceMetadata(
  url: URL,
  probe: Probe,
  config: EonConfig,
  allowMiss: boolean,
  attempts: string[] = [],
): Promise<Record<string, unknown> | undefined> {
  const response = await fetchDocument(url);
  if (allowMiss && (response.status === 404 || response.status === 405)) {
    attempts.push(`${url.toString()} -> HTTP ${response.status}. ${formatHeaders(response.headers, [config.clientSecret])}`);
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) {
    throw httpFailure("Protected resource metadata request failed", response, await response.text(), probe, config);
  }
  const metadata = parsedMetadata(await response.text(), response, probe, config, allowMiss, attempts, url);
  if (!metadata) return undefined;
  if (!Array.isArray(metadata.authorization_servers)) {
    if (!allowMiss) {
      throw new DiscoveryError(
        `Protected resource metadata did not include authorization_servers. Keys: ${Object.keys(metadata).join(", ") || "<none>"}. ${probeSummary(probe, [config.clientSecret])}`,
        response.status,
        response.headers,
      );
    }
    attempts.push(
      `${url.toString()} -> HTTP ${response.status} without authorization_servers. Keys: ${Object.keys(metadata).join(", ") || "<none>"}.`,
    );
    return undefined;
  }
  return metadata;
}

function parsedMetadata(
  text: string,
  response: Response,
  probe: Probe,
  config: EonConfig,
  allowMiss: boolean,
  attempts: string[],
  url: URL,
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    if (!allowMiss) {
      throw httpFailure("Protected resource metadata was not JSON", response, undefined, probe, config);
    }
    attempts.push(`${url.toString()} -> HTTP ${response.status} body was not JSON.`);
    return undefined;
  }
  if (!isRecord(parsed)) {
    if (!allowMiss) {
      throw httpFailure("Protected resource metadata was not a JSON object", response, undefined, probe, config);
    }
    attempts.push(`${url.toString()} -> HTTP ${response.status} body was not a JSON object.`);
    return undefined;
  }
  return parsed;
}

function protectedResourceMetadataUrls(base: URL): URL[] {
  const suffix = base.pathname.replace(/\/+$/, "");
  const urls = [new URL(`${base.origin}/.well-known/oauth-protected-resource`)];
  if (suffix) {
    urls.unshift(new URL(`${base.origin}/.well-known/oauth-protected-resource${suffix}`));
  }
  return urls;
}

async function tokenEndpointFor(
  metadata: Record<string, unknown>,
  probe: Probe,
  config: EonConfig,
): Promise<string> {
  const issuers = authorizationServers(metadata);
  const misses: string[] = [];
  for (const issuer of issuers) {
    let metadataUrls: string[];
    try {
      metadataUrls = authorizationServerMetadataUrls(issuer);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid authorization server issuer.";
      throw new DiscoveryError(`${message} ${probeSummary(probe, [config.clientSecret])}`, probe.status, probe.headers);
    }
    for (const metadataUrl of metadataUrls) {
      const response = await fetchDocument(metadataUrl);
      if (response.status === 404 || response.status === 405) {
        misses.push(`${metadataUrl} -> HTTP ${response.status}. ${formatHeaders(response.headers, [config.clientSecret])}`);
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        throw httpFailure("Authorization server metadata request failed", response, await response.text(), probe, config);
      }
      const body = parseJson(await response.text(), "Authorization server metadata", response, probe, config);
      if (!isRecord(body) || typeof body.token_endpoint !== "string" || body.token_endpoint.length === 0) {
        const keys = isRecord(body) ? Object.keys(body).join(", ") : "not an object";
        misses.push(`${metadataUrl} -> HTTP ${response.status} without token_endpoint. Keys: ${keys}.`);
        continue;
      }
      const endpoint = resolveHttps(body.token_endpoint, new URL(metadataUrl), "token_endpoint");
      return endpoint.toString();
    }
  }

  throw new DiscoveryError(
    `Authorization server metadata did not include token_endpoint. ${misses.join(" || ")} ${probeSummary(probe, [config.clientSecret])}`,
    probe.status,
    probe.headers,
  );
}

function authorizationServers(metadata: Record<string, unknown>): string[] {
  const value = metadata.authorization_servers;
  if (!Array.isArray(value)) {
    throw new Error(
      `Protected resource metadata did not include authorization_servers. Keys: ${Object.keys(metadata).join(", ") || "<none>"}.`,
    );
  }
  const issuers = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (issuers.length === 0) {
    throw new Error("Protected resource metadata authorization_servers did not include an issuer URL.");
  }
  return issuers;
}

function resourceIdentifier(metadata: Record<string, unknown>, config: EonConfig, connector: string): string {
  if (typeof metadata.resource === "string" && metadata.resource.length > 0) {
    return resolveHttps(metadata.resource, applyBaseTemplate(config.baseTemplate, connector), "resource").toString();
  }
  return canonicalConnectorResource(config.baseTemplate, connector);
}

function requestedScope(header: string | null, metadata: Record<string, unknown>): string | undefined {
  const challenged = bearerParams(header).scope;
  if (challenged) return challenged;
  if (!Array.isArray(metadata.scopes_supported)) return undefined;
  const scopes = metadata.scopes_supported.filter((item): item is string => typeof item === "string" && item.length > 0);
  return scopes.length > 0 ? scopes.join(" ") : undefined;
}

async function requestToken(endpoint: EndpointRecord): Promise<TokenRecord> {
  const config = readEonConfig();
  const secrets = [config.clientSecret];
  const form = new URLSearchParams();
  form.set("grant_type", "client_credentials");
  form.set("client_id", config.clientId);
  form.set("client_secret", config.clientSecret);
  form.set("resource", endpoint.resource);
  if (endpoint.scope) form.set("scope", endpoint.scope);

  const response = await fetchDocument(endpoint.tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new DiscoveryError(
      `Token request failed. HTTP ${response.status}. ${formatHeaders(response.headers, secrets)} Body: ${excerpt(text, secrets)}`,
      response.status,
      response.headers,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new DiscoveryError(
      `Token response was not JSON. HTTP ${response.status}. ${formatHeaders(response.headers, secrets)}`,
      response.status,
      response.headers,
    );
  }
  if (!isRecord(payload) || typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    const keys = isRecord(payload) ? Object.keys(payload).join(", ") : "not an object";
    throw new DiscoveryError(
      `Token response did not include access_token. HTTP ${response.status}. Keys: ${keys}.`,
      response.status,
      response.headers,
    );
  }
  if (payload.token_type !== undefined && String(payload.token_type).toLowerCase() !== "bearer") {
    throw new DiscoveryError(
      `Token response token_type must be Bearer. HTTP ${response.status}.`,
      response.status,
      response.headers,
    );
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new DiscoveryError(
      `Token response did not include a positive expires_in. HTTP ${response.status}.`,
      response.status,
      response.headers,
    );
  }

  const lifetimeMs = expiresIn * 1000;
  const skewMs = Math.min(REFRESH_SKEW_MS, Math.floor(lifetimeMs / 2));
  return {
    accessToken: payload.access_token,
    refreshAtMs: Date.now() + lifetimeMs - skewMs,
  };
}

async function fetchDocument(url: URL | string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      method: init.method ?? "GET",
      redirect: "follow",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    throw new Error(`Discovery request failed: ${redactSensitive(message, cachedSecretValues())}`);
  }
}

function parseJson(
  text: string,
  label: string,
  response: Response,
  probe: Probe,
  config: EonConfig,
): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw httpFailure(`${label} was not JSON`, response, undefined, probe, config);
  }
}

function httpFailure(
  summary: string,
  response: Response,
  body: string | undefined,
  probe: Probe,
  config: EonConfig,
): DiscoveryError {
  const secrets = [config.clientSecret];
  const bodyText = body ? ` Body: ${excerpt(body, secrets)}` : "";
  return new DiscoveryError(
    `${summary}. HTTP ${response.status}. ${formatHeaders(response.headers, secrets)}${bodyText} ${probeSummary(probe, secrets)}`,
    response.status,
    response.headers,
  );
}

function probeSummary(probe: Probe, secrets: readonly string[]): string {
  return `Unauthenticated probe HTTP ${probe.status}. ${formatHeaders(probe.headers, secrets)}`;
}

function excerpt(text: string, secrets: readonly string[]): string {
  const redacted = redactSensitive(text, secrets).replace(/\s+/g, " ").trim();
  return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
}

function resolveHttps(value: string, base: URL, label: string): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${label} must be an https URL without user info.`);
  }
  return url;
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function bearerParams(header: string | null): Record<string, string> {
  if (!header) return {};
  const challenges = parseChallenges(header);
  const bearer = challenges.find((challenge) => challenge.scheme.toLowerCase() === "bearer");
  if (bearer) return bearer.params;
  return challenges.find((challenge) => challenge.params.resource_metadata)?.params ?? {};
}

function parseChallenges(header: string): Challenge[] {
  const challenges: Challenge[] = [];
  const source = header.trim();
  let index = 0;

  while (index < source.length) {
    index = skipSeparators(source, index);
    if (index >= source.length) break;
    const schemeStart = index;
    index = readTokenEnd(source, index);
    const scheme = source.slice(schemeStart, index);
    if (!scheme) break;
    const params: Record<string, string> = {};
    index = skipSpace(source, index);

    while (index < source.length) {
      if (source[index] === ",") {
        const next = skipSpace(source, index + 1);
        const tokenEnd = readTokenEnd(source, next);
        const word = source.slice(next, tokenEnd);
        const after = skipSpace(source, tokenEnd);
        if (!word || source[after] !== "=") break;
        index = next;
      }

      const keyStart = index;
      index = readTokenEnd(source, index);
      const key = source.slice(keyStart, index);
      if (!key) break;
      index = skipSpace(source, index);
      if (source[index] !== "=") break;
      index = skipSpace(source, index + 1);
      const parsed = readAuthValue(source, index);
      params[key.toLowerCase()] = parsed.value;
      index = skipSpace(source, parsed.index);
    }

    challenges.push({ scheme, params });
  }

  return challenges;
}

function readAuthValue(source: string, index: number): { value: string; index: number } {
  if (source[index] === '"') {
    let value = "";
    index += 1;
    while (index < source.length) {
      const char = source[index] ?? "";
      if (char === "\\") {
        value += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === '"') return { value, index: index + 1 };
      value += char;
      index += 1;
    }
    return { value, index };
  }

  const start = index;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === "," || isSpace(char)) break;
    index += 1;
  }
  return { value: source.slice(start, index), index };
}

function skipSeparators(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && (source[cursor] === "," || isSpace(source[cursor] ?? ""))) cursor += 1;
  return cursor;
}

function skipSpace(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && isSpace(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

function readTokenEnd(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && TOKEN_CHAR.test(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function clipHeader(key: string, value: string): string {
  const limit = key === "www-authenticate" ? 4_000 : 500;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
