import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = new URL("../src/", import.meta.url).pathname;

/** The local files that a file imports at run time, as paths. A type import leaves no trace in the built code. */
function localImports(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const specifiers = [...text.matchAll(/^(?:import|export)\s(?!type\s)[^"']*?from\s+"(\.[^"]+)"/gm)].map((match) => match[1]!);
  return specifiers.map((specifier) => join(path, "..", specifier.replace(/\.js$/, ".ts")));
}

function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    if (statSync(path).isFile()) pending.push(...localImports(path).filter((next) => next.endsWith(".ts")));
  }
  return [...seen];
}

describe("the entry points", () => {
  it("the public entry imports no node: module", () => {
    const offenders = importGraph(join(SOURCE, "index.ts")).filter((path) => /from\s+"node:/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("reaches the msgboard client, the proof queue client and the RPC readers", () => {
    const graph = importGraph(join(SOURCE, "index.ts"));
    for (const part of ["msgboard/board.ts", "backend-client.ts", "rpc/chain-reader.ts", "connection.ts"]) expect(graph.some((path) => path.endsWith(part))).toBe(true);
  });

  it("finds the source files it checks", () => {
    expect(readdirSync(SOURCE)).toContain("index.ts");
  });
});
