import { applyBaseTemplate, readEonConfig } from "./config";
import { cachedSecretValues, getEonAccessToken, headersToObject, redactSensitive } from "./auth";

const READ_METHODS = new Set(["GET", "HEAD"]);

export class EonHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, body: string, headers: Readonly<Record<string, string>>) {
    super(`Connector request failed with HTTP ${status}.`);
    this.name = "EonHttpError";
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export function connectorUrl(template: string, connector: string, path: string): URL {
  if (path.includes("\\") || path.includes("\n") || path.includes("\r") || path.split(/[?#]/, 1)[0]?.split("/").includes("..")) {
    throw new Error("Connector path is invalid.");
  }
  const base = applyBaseTemplate(template, connector);
  const url = path.startsWith("/") ? new URL(path, base.origin) : new URL(path, trailingSlash(base));
  if (url.origin !== base.origin || url.username || url.password) {
    throw new Error("Connector path must stay on the connector origin.");
  }
  return url;
}

function trailingSlash(url: URL): string {
  const href = url.href;
  return href.endsWith("/") ? href : `${href}/`;
}

export async function connectorRequest(
  connector: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? "GET").trim().toUpperCase();
  if (!READ_METHODS.has(method)) {
    throw new Error(`Refusing to send ${method}. The Eon client only uses GET and HEAD.`);
  }

  const config = readEonConfig();
  const url = connectorUrl(config.baseTemplate, connector, path);
  const send = (token: string) => sendRead(url, method, init, token);
  let auth = await getEonAccessToken(connector);
  let response = await send(auth.accessToken);
  if (response.status === 401) {
    await response.body?.cancel();
    auth = await getEonAccessToken(connector, { forceRefresh: true });
    response = await send(auth.accessToken);
  }
  return response;
}

export async function eonFetch(
  connector: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await connectorRequest(connector, path, init);
  if (!response.ok) {
    const secrets = cachedSecretValues();
    const body = redactSensitive(await response.text(), secrets).slice(0, 8_000);
    throw new EonHttpError(response.status, body, headersToObject(response.headers, secrets));
  }
  return response;
}

async function sendRead(url: URL, method: string, init: RequestInit, token: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.set("authorization", `Bearer ${token}`);
  if (!headers.has("accept")) {
    headers.set("accept", "application/json, */*;q=0.1");
  }
  const signals = [AbortSignal.timeout(30_000)];
  if (init.signal) signals.push(init.signal);
  return fetch(url, {
    ...init,
    method,
    headers,
    body: undefined,
    credentials: "omit",
    cache: "no-store",
    redirect: init.redirect ?? "follow",
    signal: AbortSignal.any(signals),
  });
}

