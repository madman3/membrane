import type {
  CreateMemoryInput,
  MemoryCandidate,
  MemoryCandidateDetail,
  MemoryVersion,
} from "@memeval/contracts";
import { isUniqueViolation, type MemoryRepository } from "@memeval/database";
import { ConflictError, NotFoundError } from "../lib/errors";

export class MemoryService {
  constructor(private readonly memories: MemoryRepository) {}

  list(): Promise<MemoryCandidate[]> {
    return this.memories.listCandidates();
  }

  async get(id: string): Promise<MemoryCandidateDetail> {
    const candidate = await this.memories.getCandidate(id);
    if (!candidate) throw new NotFoundError("Memory candidate was not found.");
    return candidate;
  }

  create(input: CreateMemoryInput): Promise<MemoryCandidateDetail> {
    return this.memories.createCandidate(input);
  }

  async addVersion(id: string, content: string): Promise<MemoryVersion> {
    try {
      const version = await this.memories.addVersion(id, content);
      if (!version) throw new NotFoundError("Memory candidate was not found.");
      return version;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      if (isUniqueViolation(error)) {
        throw new ConflictError("A version with that number already exists. Refresh and try again.");
      }
      throw error;
    }
  }
}
