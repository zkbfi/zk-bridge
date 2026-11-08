import { describe, expect, it } from "vitest";
import { DEFAULT_PAIR_NAME, PAIR_DEFINITIONS, beaconVariableName, deliveryRoutersOf, describePair, finalityVariableName, loadPair, otherSide, rpcVariableName, sideOf } from "../src/pairs.js";

const section = (chainId: number, seed: string) => ({
  name: `chain-${chainId}`,
  rpc_url: `http://127.0.0.1:${28000 + chainId}`,
  chain_id: chainId,
  token: `0x${seed.repeat(40)}`,
  wrapped_native: `0x${seed.repeat(40)}`.replace(/./g, (c, i) => (i < 2 ? c : "a")),
  bridge: `0x${seed.repeat(40)}`,
  mediator: `0x${"AB".repeat(20)}`,
  token_factory: `0x${seed.repeat(40)}`,
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

  it("reads the state URLs of a chain as a comma list, and refuses one that is not http", () => {
    const pair = loadPair({ environment: { EXPLORER_STATE_URLS_1: " https://a.example , https://b.example/ ," }, deployment });
    expect(pair.sides[0].stateUrls).toEqual(["https://a.example", "https://b.example/"]);
    expect(pair.sides[1].stateUrls).toEqual([]);
    expect(() => loadPair({ environment: { EXPLORER_STATE_URLS_1: "ftp://x.example" }, deployment })).toThrow(/EXPLORER_STATE_URLS_1/);
  });

  it("reads the header RPCs of a chain as a comma list, and refuses one that is not http", () => {
    const pair = loadPair({ environment: { EXPLORER_HEADER_RPC_URL_1: " https://h.example , https://i.example/k ," }, deployment });
    expect(pair.sides[0].headerRpcUrls).toEqual(["https://h.example", "https://i.example/k"]);
    expect(pair.sides[1].headerRpcUrls).toEqual([]);
    expect(() => loadPair({ environment: { EXPLORER_HEADER_RPC_URL_1: "ws://x.example" }, deployment })).toThrow(/EXPLORER_HEADER_RPC_URL_1/);
    const withHandoffs = loadPair({ environment: { EXPLORER_HANDOFF_URLS_1: "https://h.example" }, deployment });
    expect(withHandoffs.sides[0].handoffUrls).toEqual(["https://h.example"]);
    expect("handoffUrls" in withHandoffs.sides[1]).toBe(false);
    expect(() => loadPair({ environment: { EXPLORER_HANDOFF_URLS_1: "ftp://x.example" }, deployment })).toThrow(/EXPLORER_HANDOFF_URLS_1/);
  });

  it("lets a chain start with no endpoint when the caller does not require one, so the user can set it later", () => {
    const stripped = { chain_a: { ...deployment.chain_a, rpc_url: undefined }, chain_b: deployment.chain_b };
    const pair = loadPair({ environment: {}, deployment: stripped, requireRpcUrl: false });
    expect(pair.sides[0].rpcUrl).toBe("");
    expect(pair.sides[1].rpcUrl).toBe("http://127.0.0.1:28369");
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

describe("the optional contracts of a chain section", () => {
  const withOptional = (extra: Record<string, unknown>) => ({ chain_a: { ...deployment.chain_a, ...extra }, chain_b: deployment.chain_b });

  it("gives null when the deployment file has no delivery router and no fork registry, or has null", () => {
    const missing = loadPair({ environment: {}, deployment });
    expect(missing.sides[0].contracts.deliveryRouter).toBeNull();
    expect(missing.sides[0].contracts.forkRegistry).toBeNull();
    const explicitNull = loadPair({ environment: {}, deployment: withOptional({ delivery_router: null, fork_registry: null }) });
    expect(explicitNull.sides[0].contracts.deliveryRouter).toBeNull();
    expect(explicitNull.sides[0].contracts.forkRegistry).toBeNull();
  });

  it("lowercases a delivery router and a fork registry when the file has them", () => {
    const pair = loadPair({ environment: {}, deployment: withOptional({ delivery_router: `0x${"AB".repeat(20)}`, fork_registry: `0x${"CD".repeat(20)}` }) });
    expect(pair.sides[0].contracts.deliveryRouter).toBe(`0x${"ab".repeat(20)}`);
    expect(pair.sides[0].contracts.forkRegistry).toBe(`0x${"cd".repeat(20)}`);
  });

  it("reads the earlier routers of delivery_routers, and lists every router once, the current one first", () => {
    const pair = loadPair({ environment: {}, deployment: withOptional({ delivery_router: `0x${"AB".repeat(20)}`, delivery_routers: [`0x${"CD".repeat(20)}`, `0x${"ab".repeat(20)}`] }) });
    expect(pair.sides[0].contracts.deliveryRouters).toEqual([`0x${"cd".repeat(20)}`, `0x${"ab".repeat(20)}`]);
    expect(deliveryRoutersOf(pair.sides[0])).toEqual([`0x${"ab".repeat(20)}`, `0x${"cd".repeat(20)}`]);
    expect(loadPair({ environment: {}, deployment }).sides[0].contracts.deliveryRouters).toEqual([]);
    expect(deliveryRoutersOf(loadPair({ environment: {}, deployment }).sides[0])).toEqual([]);
    expect(deliveryRoutersOf({ contracts: { deliveryRouter: null } })).toEqual([]);
  });
});

describe("the finality override", () => {
  it.each(["abc", "-1", "1.5"])("refuses the value %j and names the variable", (value) => {
    expect(() => loadPair({ environment: { EXPLORER_FINALITY_SECONDS_1: value }, deployment })).toThrow(
      "EXPLORER_FINALITY_SECONDS_1 must be a whole number",
    );
  });

  it("treats an empty value as no override and accepts zero", () => {
    expect(loadPair({ environment: { EXPLORER_FINALITY_SECONDS_1: "" }, deployment }).sides[0].finalitySeconds).toBe(
      loadPair({ environment: {}, deployment }).sides[0].finalitySeconds,
    );
    expect(loadPair({ environment: { EXPLORER_FINALITY_SECONDS_1: "0" }, deployment }).sides[0].finalitySeconds).toBe(0);
  });
});

describe("the pair registry", () => {
  it("holds both known pairs and keeps eth-pls the default", () => {
    expect(PAIR_DEFINITIONS.map((definition) => definition.name)).toEqual(["eth-pls", "sepolia-pls943"]);
    expect(DEFAULT_PAIR_NAME).toBe("eth-pls");
    expect(loadPair({ environment: {}, deployment }).name).toBe("eth-pls");
  });

  it("joins Sepolia (11155111) and PulseChain testnet v4 (943) in the second pair", () => {
    const definition = PAIR_DEFINITIONS.find((candidate) => candidate.name === "sepolia-pls943");
    expect(definition?.sides).toEqual([
      { name: "sepolia", chainId: 11155111 },
      { name: "pulsechain-testnet-v4", chainId: 943 },
    ]);
  });

  it("gives every chain identifier to one pair side only, so that a chain never belongs to two pairs by accident", () => {
    const chainIds = PAIR_DEFINITIONS.flatMap((definition) => definition.sides.map((side) => side.chainId));
    expect(new Set(chainIds).size).toBe(chainIds.length);
  });
});

describe("the sepolia-pls943 pair", () => {
  const testnet = { chain_a: section(11155111, "3"), chain_b: section(943, "4") };
  const load = (deploymentFile: unknown, environment = {}) => loadPair({ pairName: "sepolia-pls943", environment, deployment: deploymentFile });

  it("matches sections by chain identifier and keeps the sides in registry order", () => {
    const pair = load(testnet);
    expect(pair.name).toBe("sepolia-pls943");
    expect(pair.sides.map((side) => [side.name, side.chainId])).toEqual([
      ["sepolia", 11155111],
      ["pulsechain-testnet-v4", 943],
    ]);
    expect(pair.sides[0].contracts.bridge).toBe(`0x${"3".repeat(40)}`);
    expect(pair.sides[1].contracts.bridge).toBe(`0x${"4".repeat(40)}`);
    expect(pair.sides[0].rpcUrl).toBe("http://127.0.0.1:11183111");
    expect(pair.sides[1].rpcUrl).toBe("http://127.0.0.1:28943");
  });

  it("gives the same sides when the file lists the sections in the other order", () => {
    const pair = load({ chain_a: testnet.chain_b, chain_b: testnet.chain_a });
    expect(pair.sides[0].chainId).toBe(11155111);
    expect(pair.sides[0].contracts.bridge).toBe(`0x${"3".repeat(40)}`);
    expect(pair.sides[1].chainId).toBe(943);
    expect(pair.sides[1].contracts.bridge).toBe(`0x${"4".repeat(40)}`);
  });

  it("refuses a file that holds the mainnet sections, because the chain identifiers differ", () => {
    expect(() => load(deployment)).toThrow(/chain 11155111/);
  });

  it("refuses a file that lacks the section of chain 943 and names that chain", () => {
    expect(() => load({ chain_a: testnet.chain_a })).toThrow(/chain 943, found 0/);
  });

  it("takes the default finality from the slot length of each chain: 768 seconds on Sepolia, 640 on chain 943", () => {
    const pair = load(testnet);
    expect(pair.sides[0].finalitySeconds).toBe(768);
    expect(pair.sides[1].finalitySeconds).toBe(640);
  });

  it("reads the endpoints and the finality override by the new chain identifiers only", () => {
    const pair = load(testnet, {
      EXPLORER_RPC_URL_11155111: "https://rpc.example/sepolia",
      EXPLORER_BEACON_URL_943: "https://beacon.example/943",
      EXPLORER_FINALITY_SECONDS_943: "99",
      EXPLORER_FINALITY_SECONDS_369: "5",
    });
    expect(pair.sides[0].rpcUrl).toBe("https://rpc.example/sepolia");
    expect(pair.sides[0].beaconUrl).toBeNull();
    expect(pair.sides[1].beaconUrl).toBe("https://beacon.example/943");
    expect(pair.sides[1].finalitySeconds).toBe(99);
    expect(pair.sides[0].finalitySeconds).toBe(768);
  });

  it("finds each side by chain identifier", () => {
    const pair = load(testnet);
    expect(otherSide(pair, 11155111).chainId).toBe(943);
    expect(otherSide(pair, 943).chainId).toBe(11155111);
    expect(() => otherSide(pair, 1)).toThrow(/not in pair sepolia-pls943/);
  });
});

describe("an unknown pair", () => {
  it("lists both known names in the error", () => {
    expect(() => loadPair({ pairName: "nope", environment: {}, deployment })).toThrow('unknown pair "nope" (known: eth-pls, sepolia-pls943)');
  });
});

describe("the variable names", () => {
  it("name the chain identifier of the new chains", () => {
    expect(rpcVariableName(11155111)).toBe("EXPLORER_RPC_URL_11155111");
    expect(rpcVariableName(943)).toBe("EXPLORER_RPC_URL_943");
    expect(beaconVariableName(11155111)).toBe("EXPLORER_BEACON_URL_11155111");
    expect(beaconVariableName(943)).toBe("EXPLORER_BEACON_URL_943");
    expect(finalityVariableName(11155111)).toBe("EXPLORER_FINALITY_SECONDS_11155111");
    expect(finalityVariableName(943)).toBe("EXPLORER_FINALITY_SECONDS_943");
  });
});
