import { z } from "zod";
import type { CreateMemoryInput, MemoryCandidate, MemoryCandidateDetail, MemoryVersion } from "@memeval/contracts";
import { memoryCandidateDetailSchema } from "@memeval/contracts";
import { RecordId, type Surreal, surql } from "surrealdb";
import { mapCandidate, mapVersion } from "./map";

export function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique|already contains|already exists|duplicate/i.test(message);
}

export function isConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|ENOTFOUND|WebSocket|fetch failed|socket disconnected/i.test(message);
}

function rowsFrom(result: unknown, statementIndex = 0): unknown[] {
  if (!Array.isArray(result)) {
    throw new Error("Unexpected database response.");
  }
  const statement = result[statementIndex];
  if (!Array.isArray(statement)) {
    throw new Error("Unexpected database response.");
  }
  return statement;
}

function compactScope(scope: CreateMemoryInput["scope"]) {
  return {
    ...(scope.agentIds?.length ? { agentIds: scope.agentIds } : {}),
    ...(scope.customerIds?.length ? { customerIds: scope.customerIds } : {}),
    ...(scope.taskTypes?.length ? { taskTypes: scope.taskTypes } : {}),
  };
}

function compactProvenance(provenance: CreateMemoryInput["provenance"]) {
  return {
    sourceSystem: provenance.sourceSystem,
    sourceRecordId: provenance.sourceRecordId,
    ...(provenance.observedAt ? { observedAt: new Date(provenance.observedAt) } : {}),
    ...(provenance.description ? { description: provenance.description } : {}),
  };
}

export class MemoryRepository {
  constructor(private readonly db: Surreal) {}

  async listCandidates(): Promise<MemoryCandidate[]> {
    const result: unknown = await this.db.query(
      surql`SELECT * FROM memory_candidate ORDER BY createdAt DESC`,
    );
    return rowsFrom(result).map(mapCandidate);
  }

  async getCandidate(id: string): Promise<MemoryCandidateDetail | null> {
    const candidateRef = new RecordId("memory_candidate", z.uuid().parse(id));
    const result: unknown = await this.db.query(surql`
      SELECT * FROM ${candidateRef};
      SELECT * FROM memory_version WHERE candidateId = ${candidateRef} ORDER BY version ASC;
    `);
    const row = rowsFrom(result, 0)[0];
    if (!row) return null;
    return memoryCandidateDetailSchema.parse({
      ...mapCandidate(row),
      versions: rowsFrom(result, 1).map(mapVersion),
    });
  }

  async createCandidate(input: CreateMemoryInput): Promise<MemoryCandidateDetail> {
    const id = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const candidateRef = new RecordId("memory_candidate", id);
    const versionRef = new RecordId("memory_version", versionId);

    await this.db.transaction([
      surql`CREATE ${candidateRef} CONTENT ${{
        title: input.title,
        content: input.content,
        memoryType: input.memoryType,
        scope: compactScope(input.scope),
        provenance: compactProvenance(input.provenance),
        status: input.status,
      }}`,
      surql`CREATE ${versionRef} CONTENT ${{
        candidateId: candidateRef,
        version: 1,
        content: input.content,
      }}`,
    ]);

    const created = await this.getCandidate(id);
    if (!created) {
      throw new Error("The memory candidate was written but could not be read back.");
    }
    return created;
  }

  async addVersion(id: string, content: string): Promise<MemoryVersion | null> {
    const candidateRef = new RecordId("memory_candidate", z.uuid().parse(id));
    const existing: unknown = await this.db.query(surql`SELECT id FROM ${candidateRef}`);
    if (!rowsFrom(existing)[0]) return null;

    const latest: unknown = await this.db.query(
      surql`SELECT version FROM memory_version WHERE candidateId = ${candidateRef} ORDER BY version DESC LIMIT 1`,
    );
    const latestRow = rowsFrom(latest)[0];
    const currentVersion =
      latestRow && typeof latestRow === "object" && "version" in latestRow
        ? Number(latestRow.version)
        : 0;
    const versionRef = new RecordId("memory_version", crypto.randomUUID());

    await this.db.transaction([
      surql`UPDATE ${candidateRef} SET content = ${content}`,
      surql`CREATE ${versionRef} CONTENT ${{
        candidateId: candidateRef,
        version: currentVersion + 1,
        content,
      }}`,
    ]);

    const stored: unknown = await this.db.query(surql`SELECT * FROM ${versionRef}`);
    const row = rowsFrom(stored)[0];
    if (!row) {
      throw new Error("The memory version was written but could not be read back.");
    }
    return mapVersion(row);
  }
}
