import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPairFromEnvironment } from "../../src/lib/pair-from-environment";

const section = (chainId: number, digit: string) => ({
  chain_id: chainId,
  bridge: `0x${digit.repeat(40)}`,
  mediator: `0x${digit.repeat(40)}`,
  token_factory: `0x${digit.repeat(40)}`,
  native_router: `0x${digit.repeat(40)}`,
  wrapped_native: `0x${digit.repeat(40)}`,
  gate: `0x${digit.repeat(40)}`,
  light_client: `0x${digit.repeat(40)}`,
  start_block: 3,
});

describe("loadPairFromEnvironment", () => {
  it("reads the deployment file named by the variable and the endpoints from the environment", () => {
    const directory = mkdtempSync(join(tmpdir(), "explorer-pair-"));
    const file = join(directory, "deployment.json");
    writeFileSync(file, JSON.stringify({ chain_a: section(1, "1"), chain_b: section(369, "2") }));
    const pair = loadPairFromEnvironment(
      { EXPLORER_DEPLOYMENT_FILE: file, EXPLORER_RPC_URL_1: "http://a", EXPLORER_RPC_URL_369: "http://b" },
      directory,
    );
    expect(pair.sides.map((side) => side.rpcUrl)).toEqual(["http://a", "http://b"]);
    expect(pair.sides[0].startBlock).toBe(3);
  });

  it("names the variable and the path when the file is missing", () => {
    expect(() => loadPairFromEnvironment({ EXPLORER_DEPLOYMENT_FILE: "/nonexistent/x.json" })).toThrow(
      /^cannot read the deployment file \/nonexistent\/x\.json \(set EXPLORER_DEPLOYMENT_FILE\): ENOENT/,
    );
  });

  it("names the variable when the file is not JSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "explorer-pair-"));
    writeFileSync(join(directory, "bad.json"), "{not json");
    expect(() => loadPairFromEnvironment({ EXPLORER_DEPLOYMENT_FILE: "bad.json" }, directory)).toThrow(/set EXPLORER_DEPLOYMENT_FILE\): .*JSON/);
  });

  it("looks for ../deployments/<pair>.json when no file is named, and the pair defaults to eth-pls", () => {
    const directory = mkdtempSync(join(tmpdir(), "explorer-pair-"));
    expect(() => loadPairFromEnvironment({}, join(directory, "workspace"))).toThrow(
      `cannot read the deployment file ${join(directory, "deployments", "eth-pls.json")}`,
    );
    expect(() => loadPairFromEnvironment({ EXPLORER_PAIR: "other" }, join(directory, "workspace"))).toThrow(
      `${join(directory, "deployments", "other.json")}`,
    );
  });
});
