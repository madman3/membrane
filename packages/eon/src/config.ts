import { z } from "zod";

const DEFAULT_BASE_TEMPLATE = "https://{connector}-mcp.era.eon.io";
const connectorNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const eonConfigSchema = z.object({
  EON_CLIENT_ID: z.string().min(1),
  EON_CLIENT_SECRET: z.string().min(1),
  EON_BASE_TEMPLATE: z
    .string()
    .min(1)
    .refine((value) => value.includes("{connector}"), {
      message: "must include the {connector} placeholder",
    })
    .refine((value) => value.startsWith("https://"), {
      message: "must start with https://",
    })
    .default(DEFAULT_BASE_TEMPLATE),
});

export type EonConfig = {
  clientId: string;
  clientSecret: string;
  baseTemplate: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function readEonConfig(env: NodeJS.ProcessEnv = process.env): EonConfig {
  const template = env.EON_BASE_TEMPLATE?.trim();
  const parsed = eonConfigSchema.safeParse({
    EON_CLIENT_ID: env.EON_CLIENT_ID,
    EON_CLIENT_SECRET: env.EON_CLIENT_SECRET,
    EON_BASE_TEMPLATE: template ? template : undefined,
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const key = issue.path.join(".") || "config";
        if (key === "EON_CLIENT_ID" || key === "EON_CLIENT_SECRET") {
          return `${key}: is invalid`;
        }
        return `${key}: ${issue.message}`;
      })
      .join("; ");
    throw new ConfigError(
      `Eon configuration is invalid (${details}). Copy .env.example to .env and set the Eon variables.`,
    );
  }

  return {
    clientId: parsed.data.EON_CLIENT_ID,
    clientSecret: parsed.data.EON_CLIENT_SECRET,
    baseTemplate: parsed.data.EON_BASE_TEMPLATE,
  };
}

export function normalizeConnectorName(connector: string): string {
  const name = connector.trim().toLowerCase();
  if (!connectorNamePattern.test(name)) {
    throw new Error(
      "Connector name must be a single hostname label of letters, numbers, and hyphens.",
    );
  }
  return name;
}

export function applyBaseTemplate(template: string, connector: string): URL {
  const name = normalizeConnectorName(connector);
  if (!template.includes("{connector}")) {
    throw new ConfigError(
      "EON_BASE_TEMPLATE must include the {connector} placeholder. Copy .env.example to .env and set the Eon variables.",
    );
  }

  let url: URL;
  try {
    url = new URL(template.replaceAll("{connector}", name));
  } catch {
    throw new ConfigError(
      "EON_BASE_TEMPLATE did not produce a valid URL. Copy .env.example to .env and set the Eon variables.",
    );
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ConfigError(
      "EON_BASE_TEMPLATE must produce an https URL without credentials. Copy .env.example to .env and set the Eon variables.",
    );
  }
  return url;
}

export function canonicalConnectorResource(template: string, connector: string): string {
  const url = applyBaseTemplate(template, connector);
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (!path) return url.origin;
  return `${url.origin}${path}`;
}
