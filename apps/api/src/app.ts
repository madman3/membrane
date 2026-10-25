import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { isConnectionError } from "@memeval/database";
import { ConflictError, NotFoundError } from "./lib/errors";
import { healthRoutes } from "./routes/health";
import { memoryRoutes } from "./routes/memories";
import type { MemoryService } from "./services/memory-service";

export type AppDependencies = {
  memories: MemoryService;
  checkDatabase: () => Promise<void>;
  webOrigin: string;
};

function allowedOrigins(webOrigin: string): Set<string> {
  const origins = new Set([webOrigin]);
  try {
    const url = new URL(webOrigin);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
      origins.add(url.origin);
    } else if (url.hostname === "127.0.0.1") {
      url.hostname = "localhost";
      origins.add(url.origin);
    }
  } catch {
    return origins;
  }
  return origins;
}

export function createApp(dependencies: AppDependencies) {
  const app = new Hono();
  const origins = allowedOrigins(dependencies.webOrigin);

  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return dependencies.webOrigin;
        return origins.has(origin) ? origin : null;
      },
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Accept"],
    }),
  );

  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - started}ms`);
  });

  app.route("/", healthRoutes(dependencies.checkDatabase));
  app.route("/memories", memoryRoutes(dependencies.memories));

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "not_found",
          message: `No route for ${c.req.method} ${c.req.path}.`,
        },
      },
      404,
    ),
  );

  app.onError((error, c) => {
    if (error instanceof NotFoundError) {
      return c.json({ error: { code: error.code, message: error.message } }, 404);
    }
    if (error instanceof ConflictError) {
      return c.json({ error: { code: error.code, message: error.message } }, 409);
    }
    if (error instanceof HTTPException) {
      return c.json(
        {
          error: {
            code: error.status === 400 ? "validation_error" : "http_error",
            message: error.status === 400 ? "Request is invalid." : error.message,
          },
        },
        error.status,
      );
    }
    if (isConnectionError(error)) {
      console.error(error);
      return c.json(
        { error: { code: "database_unavailable", message: "Database is not reachable." } },
        503,
      );
    }

    console.error(error);
    return c.json(
      { error: { code: "internal_error", message: "Unexpected server error." } },
      500,
    );
  });

  return app;
}
