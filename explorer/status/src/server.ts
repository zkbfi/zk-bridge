import { Hono } from "hono";
import { cors } from "hono/cors";
import { PAGE } from "./page.ts";
import type { Store } from "./store.ts";
import { summarize } from "./summary.ts";
import { BUCKETS, SECTIONS, SECTION_TITLES, WINDOWS, type CheckDefinition, type WindowName } from "./types.ts";

export type ServerInput = {
  readonly store: Store;
  readonly checks: readonly CheckDefinition[];
  readonly now: () => number;
  readonly intervalSeconds: number;
};

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
};

/** The read-only HTTP side: the page and `/api/status`, `/api/history`, `/api/summary`. Nothing it answers holds a secret. */
export function createServer(input: ServerInput): Hono {
  const { store, checks, now } = input;
  const app = new Hono();
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], maxAge: 86_400 }));
  // Three missed rounds: the checks have stopped.
  const staleAfter = input.intervalSeconds * 3000;

  app.get("/", (context) => context.body(PAGE, 200, PAGE_HEADERS));

  app.get("/api/status", (context) => {
    const at = now();
    const current = new Map(store.current().map((row) => [row.id, row]));
    const uptime = store.uptime(at);
    const windows = Object.keys(WINDOWS) as WindowName[];
    const sections = SECTIONS.map((id) => ({
      id,
      title: SECTION_TITLES[id],
      checks: checks
        .filter((check) => check.section === id)
        .map((check) => {
          const row = current.get(check.id);
          return {
            id: check.id,
            name: check.name,
            state: row?.state ?? "pending",
            detail: row?.detail ?? "No result yet.",
            latencyMs: row?.latencyMs ?? null,
            checkedAt: row?.at ?? null,
            since: row?.since ?? null,
            uptime: Object.fromEntries(windows.map((window) => [window, uptime[window][check.id] ?? null])),
          };
        }),
    })).filter((section) => section.checks.length > 0);
    context.header("cache-control", "no-store");
    return context.json({ generatedAt: at, summary: summarize(store.current().filter((row) => checks.some((check) => check.id === row.id)), at, staleAfter), sections });
  });

  app.get("/api/summary", (context) => {
    const summary = summarize(store.current().filter((row) => checks.some((check) => check.id === row.id)), now(), staleAfter);
    const failed = summary.status === "down" || (context.req.query("strict") !== undefined && summary.status !== "operational");
    context.header("cache-control", "no-store");
    return context.json(summary, failed ? 503 : 200);
  });

  app.get("/api/history", (context) => {
    const window = (context.req.query("window") ?? "24h") as WindowName;
    if (!(window in WINDOWS)) return context.json({ error: "window is 24h, 7d or 30d" }, 400);
    const checkId = context.req.query("check");
    if (checkId !== undefined && !checks.some((check) => check.id === checkId)) return context.json({ error: "unknown check" }, 404);
    const at = now();
    context.header("cache-control", "no-store");
    return context.json({
      window,
      buckets: BUCKETS[window],
      from: at - WINDOWS[window],
      to: at,
      checks: store.history(at, window, checkId),
      ...(checkId === undefined ? {} : { problems: store.problems(checkId, at - WINDOWS[window], 50) }),
    });
  });

  app.notFound((context) => context.json({ error: "not found" }, 404));
  return app;
}
