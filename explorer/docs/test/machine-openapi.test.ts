// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildBackendSpec, buildIndexerSpec, BACKEND_INTERNAL_ROUTES } from "../machine/openapi";

const explorer = fileURLToPath(new URL("../..", import.meta.url));

/** Every `app.get("/path")` and `app.post("/path")` of the route code, with `:name` written as `{name}`. */
const routesIn = (folder: string, recursive: boolean): string[] => {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(path);
      } else if (entry.name.endsWith(".ts")) {
        for (const match of readFileSync(path, "utf8").matchAll(/\bapp\.(get|post)\(\s*"([^"]+)"/g)) found.push(`${match[1]} ${(match[2] as string).replace(/:([A-Za-z]+)/g, "{$1}")}`);
      }
    }
  };
  walk(folder);
  return found.sort();
};

const operationsOf = (spec: { paths: Record<string, Record<string, unknown>> }): string[] =>
  Object.entries(spec.paths).flatMap(([path, item]) => Object.keys(item).map((method) => `${method} ${path}`)).sort();

describe("the OpenAPI documents", () => {
  it("describe exactly the routes of the indexer code", () => {
    expect(operationsOf(buildIndexerSpec())).toEqual(routesIn(join(explorer, "indexer/src/api/routes"), false));
  });

  it("describe the public routes of the backend code, and name the ones left out", () => {
    const code = [...routesIn(join(explorer, "backend/src"), true)];
    const described = operationsOf(buildBackendSpec());
    expect([...described, ...BACKEND_INTERNAL_ROUTES].sort()).toEqual(code);
    expect(BACKEND_INTERNAL_ROUTES).toEqual(["post /webhook/jobs/{jobId}"]);
  });

  it.each([
    ["indexer", buildIndexerSpec],
    ["backend", buildBackendSpec],
  ])("the %s document is OpenAPI 3.1 with a response for every operation and declared path parameters", (_name, build) => {
    const spec = build();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBeTruthy();
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(item as Record<string, { summary: string; parameters?: { name: string; in: string }[]; responses: Record<string, unknown> }>)) {
        expect(operation.summary, `${method} ${path}`).toBeTruthy();
        expect(Object.keys(operation.responses).length, `${method} ${path}`).toBeGreaterThan(0);
        const declared = (operation.parameters ?? []).filter((parameter) => parameter.in === "path").map((parameter) => parameter.name).sort();
        const inPath = [...path.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1] as string).sort();
        expect(declared, `${method} ${path}`).toEqual(inPath);
      }
    }
  });

  it("every $ref points at a component that exists", () => {
    for (const spec of [buildIndexerSpec(), buildBackendSpec()]) {
      const text = JSON.stringify(spec);
      const names = Object.keys(spec.components?.schemas ?? {});
      for (const match of text.matchAll(/"#\/components\/schemas\/([A-Za-z]+)"/g)) expect(names).toContain(match[1]);
    }
  });
});
