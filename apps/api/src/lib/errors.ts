export class NotFoundError extends Error {
  readonly code = "not_found" as const;

  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  readonly code = "conflict" as const;

  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
