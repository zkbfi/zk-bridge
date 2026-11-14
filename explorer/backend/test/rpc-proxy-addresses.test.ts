import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import { createAddressBook, deploymentChains, discoverContracts, readIndexerTokens, type DeploymentChain, type NodePost } from "../src/rpc-proxy/addresses.ts";

const DEPLOYMENT: unknown = JSON.parse(readFileSync(new URL("../../../deploy/deployments/sepolia-pls943.json", import.meta.url), "utf8"));

const word = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;
const GATE = "0x85fbe4c5f7992fbd97a8e4dafc821fad3b0d20f3";
const REGISTRY = "0x0f094a965f280599b41f57a5182955f4afad063f";
const OTHER_REGISTRY = "0x3333333333333333333333333333333333333333";
const LIGHT_CLIENT = "0x4444444444444444444444444444444444444444";
const OTHER_LIGHT_CLIENT = "0x5555555555555555555555555555555555555555";
const BEACON_ROOTS = "0x000f3df6d732807ef1319fb7b8bb8522d0beac02";

type Call = { id: number; params: [{ to: string; data: string }] };

/** A node that answers address views from a table keyed by `<to>:<signature>`; others revert. Records each batch. */
function fakeNode(table: Record<string, string>) {
  const batches: Call[][] = [];
  const post: NodePost = async (_chainId, body) => {
    const calls = JSON.parse(body) as Call[];
    batches.push(calls);
    return calls.map((call) => {
      const key = Object.keys(table).find((candidate) => {
        const [to, signature] = candidate.split(":") as [string, string];
        return to === call.params[0].to && toFunctionSelector(signature) === call.params[0].data;
      });
      return key === undefined ? { jsonrpc: "2.0", id: call.id, error: { code: 3, message: "execution reverted" } } : { jsonrpc: "2.0", id: call.id, result: table[key] };
    });
  };
  return { post, batches };
}

describe("deploymentChains", () => {
  it("collects every address of each chain of the deployment file, lower case, with its gates and fork registries", () => {
    const chains = deploymentChains(DEPLOYMENT);
    expect(chains.map((chain) => chain.chainId)).toEqual([11155111, 943]);
    const pulse = chains[1] as DeploymentChain;
    expect(pulse.addresses).toContain("0xbea5f0fd3712b02c25bda32c7719fb9373c0fa20");
    expect(pulse.addresses).toContain(REGISTRY);
    expect(pulse.addresses.every((address) => address === address.toLowerCase())).toBe(true);
    expect(pulse.gates).toEqual([GATE]);
    expect(pulse.forkRegistries).toEqual([REGISTRY]);
    expect((chains[0] as DeploymentChain).forkRegistries).toEqual([]);
  });

  it("reads a list of deployments, skips values that are no address, and finds nothing in a scalar", () => {
    const chains = deploymentChains([{ chain_id: 1, bridge: "0xAA" + "a".repeat(38), name: "x", nested: { list: ["0x" + "b".repeat(40), 3, null] } }, 7]);
    expect(chains).toEqual([{ chainId: 1, addresses: ["0xaa" + "a".repeat(38), "0x" + "b".repeat(40)], gates: [], forkRegistries: [] }]);
    expect(deploymentChains("text")).toEqual([]);
  });
});

describe("discoverContracts", () => {
  const chain: DeploymentChain = { chainId: 943, addresses: [], gates: [GATE], forkRegistries: [REGISTRY] };

  it("reads what a gate names and the light client of each registry, in two rounds when a gate names another registry", async () => {
    const node = fakeNode({
      [`${GATE}:forkRegistry()`]: word(OTHER_REGISTRY),
      [`${GATE}:beaconRoots()`]: word(BEACON_ROOTS),
      [`${REGISTRY}:lightClient()`]: word(LIGHT_CLIENT),
      [`${OTHER_REGISTRY}:lightClient()`]: word(OTHER_LIGHT_CLIENT),
    });
    expect((await discoverContracts(node.post, chain)).sort()).toEqual([BEACON_ROOTS, OTHER_REGISTRY, LIGHT_CLIENT, OTHER_LIGHT_CLIENT].sort());
    expect(node.batches.map((batch) => batch.length)).toEqual([3, 1]);
  });

  it("drops the zero address, reverts and answers that are no word; reads no second round for a known registry", async () => {
    const node = fakeNode({ [`${GATE}:forkRegistry()`]: word(REGISTRY), [`${GATE}:beaconRoots()`]: word(`0x${"0".repeat(40)}`), [`${REGISTRY}:lightClient()`]: "0x01" });
    expect(await discoverContracts(node.post, chain)).toEqual([REGISTRY]);
    expect(node.batches).toHaveLength(1);
  });

  it("sends nothing for a chain without gates or registries, and throws on an answer that is not a batch", async () => {
    const node = fakeNode({});
    expect(await discoverContracts(node.post, { chainId: 1, addresses: [], gates: [], forkRegistries: [] })).toEqual([]);
    expect(node.batches).toHaveLength(0);
    await expect(discoverContracts(async () => ({ error: "x" }), chain)).rejects.toThrow();
  });
});

describe("readIndexerTokens", () => {
  it("groups the indexer's tokens by chain, lower case, and skips an entry without an address", async () => {
    const urls: string[] = [];
    const fetchFunction = (async (url: string) => {
      urls.push(url);
      return Response.json({ tokens: [{ chainId: 943, address: "0xAB" + "c".repeat(38) }, { chainId: 943, address: "0x" + "d".repeat(40) }, { chainId: 1, address: "none" }] });
    }) as unknown as typeof fetch;
    const tokens = await readIndexerTokens(fetchFunction, "http://indexer.test//", 1000);
    expect(urls).toEqual(["http://indexer.test/api/tokens"]);
    expect([...tokens.entries()]).toEqual([[943, ["0xab" + "c".repeat(38), "0x" + "d".repeat(40)]]]);
  });

  it("throws when the indexer does not answer 200", async () => {
    const fetchFunction = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await expect(readIndexerTokens(fetchFunction, "http://indexer.test", 1000)).rejects.toThrow("the indexer answered 503");
  });
});

describe("createAddressBook", () => {
  const deployment = deploymentChains(DEPLOYMENT);
  const TOKEN = "0x" + "e".repeat(40);

  it("holds the deployment and the extra contracts before the first refresh, and nothing for a chain it does not serve", () => {
    const book = createAddressBook({ chainIds: [943, 1], deployment, extraContracts: (chainId) => (chainId === 1 ? ["0xAA" + "a".repeat(38)] : []), post: fakeNode({}).post });
    expect(book.contractsOf(943).has(GATE)).toBe(true);
    expect(book.contractsOf(943).has("0x64ddc23ff43ea0cd2ce9a13ef6681ee651e76e4e")).toBe(false);
    expect([...book.contractsOf(1)]).toEqual(["0xaa" + "a".repeat(38)]);
    expect(book.contractsOf(5).size).toBe(0);
  });

  it("adds what the chain and the indexer name, and keeps it when a later refresh fails", async () => {
    let fail = false;
    const node = fakeNode({ [`${REGISTRY}:lightClient()`]: word(LIGHT_CLIENT) });
    const post: NodePost = async (chainId, body) => {
      if (fail) throw new Error("eRPC is down");
      return node.post(chainId, body);
    };
    const book = createAddressBook({
      chainIds: [943, 11155111],
      deployment,
      extraContracts: () => [],
      post,
      readTokens: async () => {
        if (fail) throw new Error("indexer is down");
        return new Map([[943, [TOKEN]]]);
      },
    });
    expect(await book.refresh()).toEqual([]);
    expect(book.contractsOf(943).has(LIGHT_CLIENT)).toBe(true);
    // A token is kept apart: never a trusted contract.
    expect(book.contractsOf(943).has(TOKEN)).toBe(false);
    expect(book.tokensOf(943).has(TOKEN)).toBe(true);
    expect(book.tokensOf(11155111).has(TOKEN)).toBe(false);
    expect(book.tokensOf(5).size).toBe(0);
    fail = true;
    expect(await book.refresh()).toEqual(["chain 11155111: eRPC is down", "chain 943: eRPC is down", "indexer tokens: indexer is down"]);
    expect(book.contractsOf(943).has(LIGHT_CLIENT)).toBe(true);
    expect(book.tokensOf(943).has(TOKEN)).toBe(true);
  });

  it("asks nothing of a chain whose deployment names no gate or registry, and reads no tokens without an indexer", async () => {
    const node = fakeNode({});
    const book = createAddressBook({ chainIds: [1], deployment: [{ chainId: 1, addresses: ["0x" + "f".repeat(40)], gates: [], forkRegistries: [] }], extraContracts: () => [], post: node.post });
    expect(await book.refresh()).toEqual([]);
    expect(node.batches).toHaveLength(0);
    expect([...book.contractsOf(1)]).toEqual(["0x" + "f".repeat(40)]);
  });
});
