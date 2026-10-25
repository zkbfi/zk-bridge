import { describe, expect, it } from "vitest";
import { describePair, loadPair, otherSide, sideOf } from "../src/pairs.js";

const section = (chainId: number, seed: string) => ({
  name: `chain-${chainId}`,
  rpc_url: `http://127.0.0.1:${28000 + chainId}`,
  chain_id: chainId,
  token: `0x${seed.repeat(40)}`,
  wrapped_native: `0x${seed.repeat(40)}`.replace(/./g, (c, i) => (i < 2 ? c : "a")),
  bridge: `0x${seed.repeat(40)}`,
  mediator: `0x${"AB".repeat(20)}`,
  token_factory: `0x${seed.repeat(40)}`,
  native_router: `0x${seed.repeat(40)}`,
  gate: `0x${seed.repeat(40)}`,
  light_client: `0x${seed.repeat(40)}`,
  start_block: 7,
  gate_genesis_time: 1600000000,
});
const deployment = { chain_a: section(1, "1"), chain_b: section(369, "2") };

describe("loadPair", () => {
  it("matches sections by chain identifier and lowercases every address", () => {
    const pair = loadPair({ environment: {}, deployment });
    expect(pair.name).toBe("eth-pls");
    expect(pair.sides[0].chainId).toBe(1);
    expect(pair.sides[0].contracts.mediator).toBe(`0x${"ab".repeat(20)}`);
    expect(pair.sides[1].contracts.bridge).toBe(`0x${"2".repeat(40)}`);
    expect(pair.sides[1].startBlock).toBe(7);
  });

  it("matches sections even when the file lists them in the other order", () => {
    const pair = loadPair({ environment: {}, deployment: { chain_a: deployment.chain_b, chain_b: deployment.chain_a } });
    expect(pair.sides[0].contracts.bridge).toBe(`0x${"1".repeat(40)}`);
  });

  it("takes endpoints from the environment before the file", () => {
    const pair = loadPair({
      environment: { EXPLORER_RPC_URL_1: "https://rpc.example/1", EXPLORER_BEACON_URL_1: "https://beacon.example" },
      deployment,
    });
    expect(pair.sides[0].rpcUrl).toBe("https://rpc.example/1");
    expect(pair.sides[0].beaconUrl).toBe("https://beacon.example");
    expect(pair.sides[1].beaconUrl).toBeNull();
  });

  it("fails when no endpoint exists for a chain", () => {
    const stripped = { chain_a: { ...deployment.chain_a, rpc_url: undefined }, chain_b: deployment.chain_b };
    expect(() => loadPair({ environment: {}, deployment: stripped })).toThrow(/EXPLORER_RPC_URL_1/);
  });

  it("fails on an unknown pair and on a missing section", () => {
    expect(() => loadPair({ pairName: "nope", environment: {}, deployment })).toThrow(/unknown pair/);
    expect(() => loadPair({ environment: {}, deployment: { chain_a: deployment.chain_a } })).toThrow(/chain 369/);
  });

  it("applies the finality override", () => {
    const pair = loadPair({ environment: { EXPLORER_FINALITY_SECONDS_1: "30" }, deployment });
    expect(pair.sides[0].finalitySeconds).toBe(30);
    expect(pair.sides[1].finalitySeconds).toBe(640);
  });

  it("describes a pair without endpoints", () => {
    const description = JSON.stringify(describePair(loadPair({ environment: { EXPLORER_RPC_URL_1: "https://secret.example/key" }, deployment })));
    expect(description).not.toContain("secret.example");
    expect(description).not.toContain("rpcUrl");
  });

  it("finds the other side", () => {
    const pair = loadPair({ environment: {}, deployment });
    expect(otherSide(pair, 1).chainId).toBe(369);
    expect(sideOf(pair, 369).chainId).toBe(369);
    expect(() => otherSide(pair, 5)).toThrow();
  });
});
