import type { Hono } from "hono";
import type { BackendModuleContext } from "../module.ts";
import type { ModuleHealth } from "../health.ts";

/** A stub: a later task replaces this file. It answers 503 on its routes. */
export function register(app: Hono, _context: BackendModuleContext): void {
  app.all("/webhook/*", (context) => context.json({ error: "module not built" }, 503));
}

/** Starts nothing. */
export async function start(_context: BackendModuleContext): Promise<() => Promise<void>> {
  return async () => {};
}

/** Tells the health report that the module is a stub. */
export function health(_context: BackendModuleContext): ModuleHealth {
  return { state: "not built" };
}
