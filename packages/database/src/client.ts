import { Surreal } from "surrealdb";
import { type DatabaseConfig } from "./config";

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(value: string, name: string): void {
  if (!identifierPattern.test(value)) {
    throw new Error(`${name} must be a SurrealDB identifier (letters, numbers, and underscores).`);
  }
}

export async function connectDatabase(config: DatabaseConfig): Promise<Surreal> {
  assertIdentifier(config.namespace, "SURREAL_NS");
  assertIdentifier(config.database, "SURREAL_DB");

  const db = new Surreal();
  try {
    await db.connect(config.url, {
      authentication: {
        username: config.username,
        password: config.password,
      },
    });
    await db.query(`DEFINE NAMESPACE IF NOT EXISTS ${config.namespace}`);
    await db.use({ namespace: config.namespace });
    await db.query(`DEFINE DATABASE IF NOT EXISTS ${config.database}`);
    await db.use({ namespace: config.namespace, database: config.database });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown connection error";
    await db.close().catch(() => undefined);
    throw new Error(`Could not connect to SurrealDB at ${config.url}: ${message}`);
  }
  return db;
}

export async function checkDatabase(db: Surreal): Promise<void> {
  await db.query("RETURN true");
}
