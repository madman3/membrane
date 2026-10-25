import { normalizeConnectorName, readEonConfig } from "./config";

const REFRESH_SKEW_MS = 60_000;

export type EonAccessToken = {
  accessToken: string;
  tenant: string;
  expiresAt: number;
};

export class EonAuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "EonAuthError";
    this.status = status;
  }
}

const tokenCache = new Map<string, EonAccessToken>();
const pending = new Map<string, Promise<EonAccessToken>>();
const generations = new Map<string, number>();
let endpointCache: string | undefined;

export async function getEonAccessToken(
  connector: string,
  options?: { forceRefresh?: boolean },
): Promise<EonAccessToken> {
  const name = normalizeConnectorName(connector);
  const forceRefresh = options?.forceRefresh === true;
  if (forceRefresh) {
    tokenCache.delete(name);
    pending.delete(name);
  } else {
    const cached = freshToken(name);
    if (cached) return cached;
    const inflight = pending.get(name);
    if (inflight) return inflight;
  }

  const generation = (generations.get(name) ?? 0) + 1;
  generations.set(name, generation);
  const promise = requestToken().then((token) => {
    if (generations.get(name) === generation) tokenCache.set(name, token);
    return token;
  }).finally(() => {
    if (pending.get(name) === promise) pending.delete(name);
  });
  pending.set(name, promise);
  return promise;
}

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

export function cachedSecretValues(): string[] {
  const values: string[] = [];
  try {
    values.push(readEonConfig().clientSecret);
  } catch {
    // Configuration errors are reported by the requesting call.
  }
  for (const token of tokenCache.values()) values.push(token.accessToken);
  return values;
}

export function redactKnownSecrets(value: string): string {
  return redactSensitive(value, cachedSecretValues());
}

export function headersToObject(
  headers: Headers,
  secrets: readonly string[] = [],
): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    const hidden = key === "authorization" || key === "cookie" || key === "set-cookie";
    result[key] = hidden ? "[redacted]" : redactSensitive(value, secrets).slice(0, 500);
  });
  return result;
}

function freshToken(connector: string): EonAccessToken | undefined {
  const cached = tokenCache.get(connector);
  if (!cached || Date.now() >= cached.expiresAt - REFRESH_SKEW_MS) return undefined;
  return cached;
}

async function requestToken(): Promise<EonAccessToken> {
  const config = readEonConfig();
  endpointCache = endpointCache === config.tokenEndpoint ? endpointCache : config.tokenEndpoint;
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  let response: Response;
  try {
    response = await fetch(endpointCache, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new EonAuthError("Eon token request failed before receiving a response.");
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new EonAuthError(`Eon token request failed with HTTP ${response.status}.`, response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EonAuthError("Eon token response was not valid JSON.", response.status);
  }
  if (!isRecord(payload)) {
    throw new EonAuthError("Eon token response must be a JSON object.", response.status);
  }
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new EonAuthError("Eon token response did not include a non-empty access_token.", response.status);
  }
  if (typeof payload.tenant !== "string" || payload.tenant.length === 0) {
    throw new EonAuthError("Eon token response did not include a non-empty tenant.", response.status);
  }
  const tokenTenant = jwtTenantClaim(payload.access_token);
  if (tokenTenant !== undefined && tokenTenant !== payload.tenant) {
    throw new EonAuthError(
      "Eon token response tenant did not match the access token tenant claim.",
      response.status,
    );
  }
  if (payload.token_type !== undefined && String(payload.token_type).toLowerCase() !== "bearer") {
    throw new EonAuthError("Eon token response token_type must be Bearer.", response.status);
  }
  const expiresIn = typeof payload.expires_in === "number"
    ? payload.expires_in
    : Number(payload.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new EonAuthError("Eon token response did not include a positive expires_in.", response.status);
  }

  return {
    accessToken: payload.access_token,
    tenant: payload.tenant,
    expiresAt: Date.now() + expiresIn * 1_000,
  };
}

function jwtTenantClaim(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isRecord(payload) && typeof payload.tenant === "string" && payload.tenant.length > 0
      ? payload.tenant
      : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
