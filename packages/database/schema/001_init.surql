-- Initial schema for memory candidates and immutable content versions.
-- Statements are idempotent so a partially applied file can be retried.

DEFINE TABLE IF NOT EXISTS schema_migration SCHEMAFULL
  COMMENT "Filenames of SurrealQL migrations that have been applied.";

DEFINE FIELD IF NOT EXISTS filename ON TABLE schema_migration TYPE string
  ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS appliedAt ON TABLE schema_migration TYPE datetime
  DEFAULT time::now() READONLY;
DEFINE INDEX IF NOT EXISTS schema_migration_filename ON TABLE schema_migration FIELDS filename UNIQUE;

DEFINE TABLE IF NOT EXISTS memory_candidate SCHEMAFULL
  COMMENT "A proposed memory update. The record key is the public UUID.";

DEFINE FIELD IF NOT EXISTS title ON TABLE memory_candidate TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD IF NOT EXISTS content ON TABLE memory_candidate TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 20000;
DEFINE FIELD IF NOT EXISTS memoryType ON TABLE memory_candidate TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 80;

DEFINE FIELD IF NOT EXISTS scope ON TABLE memory_candidate TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS scope.agentIds ON TABLE memory_candidate TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS scope.agentIds.* ON TABLE memory_candidate TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 120;
DEFINE FIELD IF NOT EXISTS scope.customerIds ON TABLE memory_candidate TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS scope.customerIds.* ON TABLE memory_candidate TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 120;
DEFINE FIELD IF NOT EXISTS scope.taskTypes ON TABLE memory_candidate TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS scope.taskTypes.* ON TABLE memory_candidate TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 120;

DEFINE FIELD IF NOT EXISTS provenance ON TABLE memory_candidate TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS provenance.sourceSystem ON TABLE memory_candidate TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD IF NOT EXISTS provenance.sourceRecordId ON TABLE memory_candidate TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD IF NOT EXISTS provenance.observedAt ON TABLE memory_candidate TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS provenance.description ON TABLE memory_candidate TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 2000;

DEFINE FIELD IF NOT EXISTS status ON TABLE memory_candidate TYPE string
  ASSERT $value IN ["draft", "ready", "evaluating", "evaluated"]
  DEFAULT "draft";
DEFINE FIELD IF NOT EXISTS createdAt ON TABLE memory_candidate TYPE datetime
  DEFAULT time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updatedAt ON TABLE memory_candidate TYPE datetime
  DEFAULT time::now() VALUE time::now();

DEFINE INDEX IF NOT EXISTS memory_candidate_status ON TABLE memory_candidate FIELDS status;
DEFINE INDEX IF NOT EXISTS memory_candidate_created_at ON TABLE memory_candidate FIELDS createdAt;

DEFINE TABLE IF NOT EXISTS memory_version SCHEMAFULL
  COMMENT "Immutable content snapshot for a memory candidate.";

DEFINE FIELD IF NOT EXISTS candidateId ON TABLE memory_version TYPE record<memory_candidate>;
DEFINE FIELD IF NOT EXISTS version ON TABLE memory_version TYPE int ASSERT $value >= 1;
DEFINE FIELD IF NOT EXISTS content ON TABLE memory_version TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 20000;
DEFINE FIELD IF NOT EXISTS createdAt ON TABLE memory_version TYPE datetime
  DEFAULT time::now() READONLY;

DEFINE INDEX IF NOT EXISTS memory_version_candidate_version
  ON TABLE memory_version FIELDS candidateId, version UNIQUE;
