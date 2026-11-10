import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// This file runs a real worker thread with the real WASM engine.
vi.unmock("node:worker_threads");
const { grindPreflight } = await import("../src/msgboard/grind-preflight.js");

describe("grindPreflight on a real worker thread", () => {
  it("loads the WASM engine and finds valid work at a difficulty of 256, within a few seconds", async () => {
    const result = await grindPreflight({ timeoutMilliseconds: 20_000 });
    expect(result).toEqual({ ok: true, durationMilliseconds: expect.any(Number) });
  });

  it("reports a timeout when the limit is too short for a thread to start", async () => {
    expect(await grindPreflight({ timeoutMilliseconds: 1 })).toMatchObject({ ok: false, reason: "timeout" });
  });
});

describe("the WASM file of the install", () => {
  // The backend and the bots have no build step: they run from source on the server, after `pnpm install --frozen-lockfile`
  // (deploy/app-server/deploy.sh). So the file that the worker loads is the one in the installed package.
  it("lies where the grind worker looks for it, is a WebAssembly module, and loads in a worker thread", async () => {
    const stamperUrl = new URL("../src/msgboard/grind-stamper.mjs", import.meta.url);
    const path = createRequire(stamperUrl).resolve("@msgboard/pow-grinder/wasm");
    const wasm = join(dirname(path), "pow_grinder_bg.wasm");
    expect(existsSync(wasm)).toBe(true);
    expect([...readFileSync(wasm).subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect(fileURLToPath(stamperUrl)).toContain("/src/msgboard/");
    expect((await grindPreflight({ timeoutMilliseconds: 20_000 })).ok).toBe(true);
  });
});
