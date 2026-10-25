import {
  createMemorySchema,
  createMemoryVersionSchema,
  memoryIdParamsSchema,
} from "@memeval/contracts";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { validationHook } from "../lib/validation";
import type { MemoryService } from "../services/memory-service";

export function memoryRoutes(memories: MemoryService) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const data = await memories.list();
    return c.json({ data });
  });

  routes.post("/", zValidator("json", createMemorySchema, validationHook), async (c) => {
    const data = await memories.create(c.req.valid("json"));
    return c.json({ data }, 201);
  });

  routes.get("/:id", zValidator("param", memoryIdParamsSchema, validationHook), async (c) => {
    const data = await memories.get(c.req.valid("param").id);
    return c.json({ data });
  });

  routes.post(
    "/:id/versions",
    zValidator("param", memoryIdParamsSchema, validationHook),
    zValidator("json", createMemoryVersionSchema, validationHook),
    async (c) => {
      const data = await memories.addVersion(c.req.valid("param").id, c.req.valid("json").content);
      return c.json({ data }, 201);
    },
  );

  return routes;
}
