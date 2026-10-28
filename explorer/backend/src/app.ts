import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ModuleName } from "./config.ts";
import { buildHealthReport, type ModuleHealth } from "./health.ts";
import type { BackendModuleContext, ModuleTable } from "./module.ts";

/**
 * Builds the web application. A dapp page loaded from an IPFS gateway calls the backend from another origin, so every
 * route answers with `Access-Control-Allow-Origin: *`, and the preflight answers with the allowed methods. The
 * backend sets no cookie and reads no login from the browser, so a wildcard origin gives away nothing.
 */
export function createApp(input: { context: BackendModuleContext; modules: ModuleTable; enabled: readonly ModuleName[] }): Hono {
  const { context, modules, enabled } = input;
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      exposeHeaders: ["Retry-After"],
      maxAge: 86_400,
    }),
  );
  app.get("/health", (request) => {
    const moduleStates: Record<string, ModuleHealth> = {};
    for (const name of enabled) moduleStates[name] = modules[name].health?.(context) ?? { state: "running" };
    return request.json(buildHealthReport({ storage: context.storage, modules: moduleStates, now: context.now() }));
  });
  for (const name of enabled) modules[name].register(app, context);
  return app;
}
