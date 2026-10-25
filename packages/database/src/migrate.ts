import { connectDatabase } from "./client";
import { readDatabaseConfig } from "./config";
import { applySchema } from "./schema";

const db = await connectDatabase(readDatabaseConfig());

try {
  const applied = await applySchema(db);
  if (applied.length === 0) {
    console.log("Schema already up to date.");
  } else {
    console.log(`Applied ${applied.join(", ")}`);
  }
} finally {
  await db.close();
}
