import {
  memoryCandidateSchema,
  memoryVersionSchema,
  type MemoryCandidate,
  type MemoryProvenance,
  type MemoryScope,
  type MemoryVersion,
} from "@memeval/contracts";

const uuidPattern =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

export function recordKey(value: unknown): string {
  const text = value == null ? "" : String(value);
  const match = uuidPattern.exec(text);
  const id = match?.[0];
  if (!id) {
    throw new Error("Expected a UUID record id.");
  }
  return id;
}

export function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();

  let text = "";
  if (typeof value === "string") {
    text = value;
  } else if (
    value &&
    typeof value === "object" &&
    "toJSON" in value &&
    typeof value.toJSON === "function"
  ) {
    text = String(value.toJSON());
  } else if (value != null) {
    text = String(value);
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Expected a datetime, received ${text || "an empty value"}.`);
  }
  return parsed.toISOString();
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item));
}

export function asScope(value: unknown): MemoryScope {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    agentIds: asStringArray(record.agentIds),
    customerIds: asStringArray(record.customerIds),
    taskTypes: asStringArray(record.taskTypes),
  };
}

export function asProvenance(value: unknown): MemoryProvenance {
  if (!value || typeof value !== "object") {
    throw new Error("Memory candidate is missing provenance.");
  }
  const record = value as Record<string, unknown>;
  return {
    sourceSystem: String(record.sourceSystem ?? ""),
    sourceRecordId: String(record.sourceRecordId ?? ""),
    observedAt: record.observedAt == null ? undefined : asIso(record.observedAt),
    description: typeof record.description === "string" ? record.description : undefined,
  };
}

export function mapCandidate(row: unknown): MemoryCandidate {
  if (!row || typeof row !== "object") {
    throw new Error("Expected a memory candidate row.");
  }
  const record = row as Record<string, unknown>;
  return memoryCandidateSchema.parse({
    id: recordKey(record.id),
    title: record.title,
    content: record.content,
    memoryType: record.memoryType,
    scope: asScope(record.scope),
    provenance: asProvenance(record.provenance),
    status: record.status,
    createdAt: asIso(record.createdAt),
    updatedAt: asIso(record.updatedAt),
  });
}

export function mapVersion(row: unknown): MemoryVersion {
  if (!row || typeof row !== "object") {
    throw new Error("Expected a memory version row.");
  }
  const record = row as Record<string, unknown>;
  return memoryVersionSchema.parse({
    id: recordKey(record.id),
    candidateId: recordKey(record.candidateId),
    version: record.version,
    content: record.content,
    createdAt: asIso(record.createdAt),
  });
}
