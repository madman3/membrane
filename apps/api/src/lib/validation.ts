import type { Context } from "hono";

type ValidationIssue = {
  path: PropertyKey[];
  message: string;
};

type ValidationResult =
  | { success: true }
  | { success: false; error: { issues: ValidationIssue[] } };

export function validationHook(result: ValidationResult, c: Context) {
  if (result.success) return;

  return c.json(
    {
      error: {
        code: "validation_error",
        message: "Request is invalid.",
        details: result.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      },
    },
    400,
  );
}
