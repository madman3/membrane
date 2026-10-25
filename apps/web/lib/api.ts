import {
  apiErrorSchema,
  memoryCandidateDetailSchema,
  memoryCandidateListSchema,
  memoryVersionSchema,
  type CreateMemoryInput,
  type MemoryCandidate,
  type MemoryCandidateDetail,
  type MemoryVersion,
} from "@memeval/contracts";
import type { ZodType } from "zod";

export class ApiError extends Error {
  readonly status: number;
  readonly details: { path: string; message: string }[] | undefined;

  constructor(status: number, message: string, details?: { path: string; message: string }[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

async function request<T extends ZodType>(
  url: string,
  schema: T,
  init?: RequestInit,
): Promise<T["_output"]> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, "The API is unreachable. Start it with bun run dev:api.");
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      throw new ApiError(response.status, parsed.data.error.message, parsed.data.error.details);
    }
    throw new ApiError(response.status, "The API returned an error.");
  }

  const payload =
    body && typeof body === "object" && "data" in body ? body.data : undefined;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(response.status, "The API returned an unexpected response.");
  }
  return parsed.data;
}

export function createClient(apiUrl: string) {
  const baseUrl = apiUrl.replace(/\/$/, "");

  return {
    listMemories(): Promise<MemoryCandidate[]> {
      return request(`${baseUrl}/memories`, memoryCandidateListSchema);
    },
    getMemory(id: string): Promise<MemoryCandidateDetail> {
      return request(`${baseUrl}/memories/${id}`, memoryCandidateDetailSchema);
    },
    createMemory(input: CreateMemoryInput): Promise<MemoryCandidateDetail> {
      return request(`${baseUrl}/memories`, memoryCandidateDetailSchema, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    addVersion(id: string, content: string): Promise<MemoryVersion> {
      return request(`${baseUrl}/memories/${id}/versions`, memoryVersionSchema, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
    },
  };
}

export type MemoryClient = ReturnType<typeof createClient>;
