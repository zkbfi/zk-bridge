import { describe, expect, it } from "vitest";
import { createChainClient, execProgram } from "../src/exec.ts";

describe("execProgram", () => {
  it("gives the output of a program", async () => {
    expect(await execProgram(process.execPath, ["-e", "process.stdout.write('hello')"])).toBe("hello");
  });
  it("rejects when the program fails, with a short message", async () => {
    await expect(execProgram(process.execPath, ["-e", "process.exit(3)"])).rejects.toThrow(/failed/);
  });
});

describe("createChainClient", () => {
  it("builds a client with the reads of the checks, and makes no request", () => {
    const client = createChainClient("http://127.0.0.1:1", 1000);
    for (const read of ["getBlock", "getBlockNumber", "readContract", "call", "estimateGas", "getBalance"] as const) expect(typeof client[read]).toBe("function");
  });
});
