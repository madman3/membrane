# Memory Evaluation

Foundation for reviewing proposed memory changes in multi-agent systems. This milestone stores a memory candidate, keeps its source and scope, and records content versions. It does not run evaluations, and it does not contain Forte Partners business scenarios.

## Prerequisites

- [Bun](https://bun.sh) 1.4 or newer
- Docker, for SurrealDB

## Setup

From the repository root:

```bash
cp .env.example .env
docker compose --env-file .env -f infrastructure/docker-compose.yml up -d
bun install
bun run dev
```

Open [http://localhost:3000](http://localhost:3000).

The API listens on [http://127.0.0.1:3001](http://127.0.0.1:3001). Check it with:

```bash
curl http://127.0.0.1:3001/health
```

Run the API without the web app:

```bash
bun run dev:api
```

Run the web app alone:

```bash
bun run dev:web
```

## Schema

Migrations live in `packages/database/schema` and are applied in filename order. The API applies any pending migration when it starts. Apply them yourself with:

```bash
bun run db:migrate
```

Stop the database with:

```bash
docker compose --env-file .env -f infrastructure/docker-compose.yml down
```

## Synthetic example

```bash
bun run db:seed
```

This inserts one candidate titled `[Synthetic example] Placeholder memory candidate`. It is local test data for the interface, not Forte Partners evidence. Running the command again does not insert a second copy.

## Without Docker

The same SurrealDB 3.3.4 engine can be started from the Surreal launcher:

```bash
surreal db start --username root --password root --bind 127.0.0.1:8000 rocksdb:.data/memeval.db
```

Use the username, password, and port from `.env`. The Compose service runs `surrealdb/surrealdb:v3.3.4` and listens on `0.0.0.0:8000` inside the container.

## Layout

- `apps/web` — Next.js interface
- `apps/api` — Hono API, runnable on its own
- `packages/contracts` — Zod schemas shared by the API and the web app
- `packages/database` — SurrealDB connection, migrations, and repository
- `infrastructure/docker-compose.yml` — SurrealDB

`POST /memories` creates a candidate and version 1. `POST /memories/:id/versions` stores a new snapshot and makes that content current.
