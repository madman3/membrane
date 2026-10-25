import { connectDatabase } from "./client";
import { readDatabaseConfig } from "./config";
import { MemoryRepository } from "./repository";
import { applySchema } from "./schema";

const SYNTHETIC_SOURCE = "local-seed";
const SYNTHETIC_RECORD = "synthetic-001";

const db = await connectDatabase(readDatabaseConfig());

try {
  await applySchema(db);
  const memories = new MemoryRepository(db);
  const existing = (await memories.listCandidates()).find(
    (candidate) =>
      candidate.provenance.sourceSystem === SYNTHETIC_SOURCE &&
      candidate.provenance.sourceRecordId === SYNTHETIC_RECORD,
  );

  if (existing) {
    console.log(`Synthetic example already exists: ${existing.id}`);
    console.log("This record is local test data, not Forte Partners evidence.");
  } else {
    const created = await memories.createCandidate({
      title: "[Synthetic example] Placeholder memory candidate",
      content:
        "This record is synthetic test data for the local evaluation platform. It is not Forte Partners evidence and does not describe a real memory, customer, agent, or task.",
      memoryType: "example",
      status: "draft",
      scope: {
        agentIds: ["example-agent"],
        taskTypes: ["example-task"],
      },
      provenance: {
        sourceSystem: SYNTHETIC_SOURCE,
        sourceRecordId: SYNTHETIC_RECORD,
        description:
          "Inserted by bun run db:seed so the interface can be exercised. Not company evidence.",
      },
    });
    console.log(`Created synthetic example ${created.id}`);
    console.log("This record is local test data, not Forte Partners evidence.");
  }
} finally {
  await db.close();
}
