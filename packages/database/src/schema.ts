import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Surreal } from "surrealdb";

const schemaDirectory = join(dirname(fileURLToPath(import.meta.url)), "../schema");

async function appliedMigrations(db: Surreal): Promise<Set<string>> {
  try {
    const [rows] = await db.query<[{ filename: string }[]]>("SELECT filename FROM schema_migration");
    return new Set((rows ?? []).map((row) => row.filename));
  } catch {
    return new Set();
  }
}

export async function applySchema(db: Surreal): Promise<string[]> {
  const applied = await appliedMigrations(db);
  const files = readdirSync(schemaDirectory)
    .filter((file) => file.endsWith(".surql"))
    .sort();
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(schemaDirectory, file), "utf8");
    await db.query(sql);
    await db.query("CREATE schema_migration CONTENT { filename: $filename }", {
      filename: file,
    });
    ran.push(file);
  }

  return ran;
}
