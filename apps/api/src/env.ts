import { z } from "zod";

const envSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(3001),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
});

export type ApiEnv = z.infer<typeof envSchema>;

export function readApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`API configuration is invalid (${details}).`);
  }
  return parsed.data;
}
