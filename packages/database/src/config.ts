import { z } from "zod";

const databaseConfigSchema = z.object({
  SURREAL_URL: z
    .string()
    .min(1)
    .refine((value) => /^(ws|wss|http|https):\/\//.test(value), {
      message: "SURREAL_URL must start with ws://, wss://, http://, or https://",
    }),
  SURREAL_NS: z.string().min(1),
  SURREAL_DB: z.string().min(1),
  SURREAL_USER: z.string().min(1),
  SURREAL_PASS: z.string().min(1),
});

export type DatabaseConfig = {
  url: string;
  namespace: string;
  database: string;
  username: string;
  password: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const parsed = databaseConfigSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(
      `Database configuration is invalid (${details}). Copy .env.example to .env and set the SurrealDB variables.`,
    );
  }

  return {
    url: parsed.data.SURREAL_URL,
    namespace: parsed.data.SURREAL_NS,
    database: parsed.data.SURREAL_DB,
    username: parsed.data.SURREAL_USER,
    password: parsed.data.SURREAL_PASS,
  };
}
