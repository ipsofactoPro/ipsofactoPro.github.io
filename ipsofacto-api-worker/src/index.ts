
import { fromHono } from "chanfana";
import { Hono } from "hono";

import { authMiddleware } from "./middleware/auth";

import { TaskCreate } from "./endpoints/taskCreate";
import { TaskDelete } from "./endpoints/taskDelete";
import { TaskFetch } from "./endpoints/taskFetch";
import { TaskList } from "./endpoints/taskList";

const app = new Hono<{ Bindings: Env }>();

// Apply authentication to all /api routes
app.use("/api/*", authMiddleware);

// Setup OpenAPI registry
const openapi = fromHono(app, {
  docs_url: "/",
});

// Register OpenAPI endpoints
openapi.get("/api/tasks", TaskList);
openapi.post("/api/tasks", TaskCreate);
openapi.get("/api/tasks/:taskSlug", TaskFetch);
openapi.delete("/api/tasks/:taskSlug", TaskDelete);

export default app;
