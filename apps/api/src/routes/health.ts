import { Hono } from "hono";

export function healthRoutes(checkDatabase: () => Promise<void>) {
  const routes = new Hono();

  routes.get("/health", async (c) => {
    try {
      await checkDatabase();
      return c.json({ data: { status: "ok", database: "connected" } });
    } catch (error) {
      console.error("Health check failed", error);
      return c.json(
        {
          error: {
            code: "database_unavailable",
            message: "Database is not reachable.",
          },
        },
        503,
      );
    }
  });

  return routes;
}
