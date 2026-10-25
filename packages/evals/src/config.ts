import { z } from "zod";

const evalConfigSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  PHOENIX_BASE_URL: z
    .string()
    .min(1)
    .refine((value) => /^https?:\/\//.test(value), {
      message: "PHOENIX_BASE_URL must start with http:// or https://",
    }),
  PHOENIX_COLLECTOR_ENDPOINT: z
    .string()
    .min(1)
    .refine((value) => /^https?:\/\//.test(value), {
      message: "PHOENIX_COLLECTOR_ENDPOINT must start with http:// or https://",
    }),
  EVAL_MODEL: z.string().min(1).default("claude-haiku-5-5"),
});

export type EvalConfig = {
  anthropicApiKey: string;
  phoenixBaseUrl: string;
  phoenixCollectorEndpoint: string;
  model: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function readEvalConfig(env: NodeJS.ProcessEnv = process.env): EvalConfig {
  const parsed = evalConfigSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(
      `Eval configuration is invalid (${details}). Copy .env.example to .env and set the Anthropic and Phoenix variables.`,
    );
  }

  return {
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
    phoenixBaseUrl: parsed.data.PHOENIX_BASE_URL,
    phoenixCollectorEndpoint: parsed.data.PHOENIX_COLLECTOR_ENDPOINT,
    model: parsed.data.EVAL_MODEL,
  };
}
