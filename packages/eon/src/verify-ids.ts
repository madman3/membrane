import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getEonAccessToken } from "./auth";
import { eonFetch } from "./client";

const CONNECTOR = "zendesk";
const SHOW_MANY_CHUNK_SIZE = 100;

export function parseTicketIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    for (const item of trimmed.split(",")) {
      const id = item.trim();
      if (!id) continue;
      if (!/^[1-9]\d*$/.test(id)) {
        throw new Error(`Invalid ticket ID "${id}". IDs must be positive decimal integers.`);
      }
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

export async function verifyTicketIds(file: string): Promise<void> {
  const ids = parseTicketIds(await readFile(file, "utf8"));
  if (ids.length === 0) {
    throw new Error(
      `No ticket IDs found in ${file}. Add newline- or comma-separated IDs; blank and # comment lines are ignored. No network request was made.`,
    );
  }

  const auth = await getEonAccessToken(CONNECTOR);
  const returned = new Set<string>();
  for (let start = 0; start < ids.length; start += SHOW_MANY_CHUNK_SIZE) {
    const chunk = ids.slice(start, start + SHOW_MANY_CHUNK_SIZE);
    const query = new URLSearchParams({ ids: chunk.join(",") });
    const response = await eonFetch(
      CONNECTOR,
      `/api/v2/tickets/show_many.json?${query.toString()}`,
      { method: "GET" },
    );
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.tickets)) {
      throw new Error("Zendesk show-many response did not contain a tickets array.");
    }
    const requested = new Set(chunk);
    for (const row of payload.tickets) {
      if (!isRecord(row) || (typeof row.id !== "number" && typeof row.id !== "string")) {
        throw new Error("Zendesk show-many response contained a malformed ticket row.");
      }
      const id = String(row.id);
      if (!/^[1-9]\d*$/.test(id) || !requested.has(id) || returned.has(id)) {
        throw new Error(`Zendesk show-many response contained an invalid or duplicate ticket ID.`);
      }
      returned.add(id);
    }
  }

  const present = ids.filter((id) => returned.has(id));
  const missing = ids.filter((id) => !returned.has(id));
  console.log(`Tenant: ${auth.tenant}`);
  console.log(`Present (${present.length}): ${present.join(", ") || "<none>"}`);
  console.log(`Missing (${missing.length}): ${missing.join(", ") || "<none>"}`);
}

function defaultIdsFile(): string {
  return fileURLToPath(new URL("../ids.txt", import.meta.url));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runCli(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1) throw new Error("Usage: bun run verify-ids -- [ids-file]");
    const file = args[0] ? path.resolve(args[0]) : defaultIdsFile();
    await verifyTicketIds(file);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Ticket ID verification failed.");
    process.exitCode = 1;
  }
}

const meta = import.meta as ImportMeta & { main?: boolean };
if (meta.main ?? path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await runCli();
}
