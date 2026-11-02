import { describe, expect, it } from "vitest";
import {
  CONTRACT_ROLE_NAMES,
  DAPP_ORIGINS,
  SEARCH_SURFACES,
  ZKB_SITES,
  crossLinks,
  directionTo,
  lookupTextOf,
  resolve,
  searchChainsFromPair,
  type SearchChain,
  type SearchHeadUpdate,
  type SearchMessage,
  type SearchSources,
  type SearchToken,
} from "../src/search.js";
import { PAIR_DEFINITIONS, type Pair } from "../src/pairs.js";

const a = (seed: string): string => `0x${seed.repeat(20)}`;
const h = (seed: string): string => `0x${seed.repeat(32)}`;

const chains: readonly SearchChain[] = [
  { chainId: 11155111, name: "Sepolia", side: "first", contracts: { bridge: a("11"), mediator: a("12"), lightClient: a("13"), gate: a("14"), wrappedNative: null } },
  { chainId: 943, name: "PulseChain testnet v4", side: "second", contracts: { bridge: a("21"), mediator: a("22"), lightClient: a("23"), gate: a("24"), deliveryRouter: a("25") } },
];

const sent = h("e1");
const delivered = h("e2");
const messageId = h("a1");
const message: SearchMessage = { messageId, kind: "token", status: "waiting_for_finality", sourceChainId: 11155111, destinationChainId: 943, sentTransactionHash: sent, deliveredTransactionHash: delivered, symbol: "USDC" };
const plain: SearchMessage = { ...message, messageId: h("a2"), kind: "message", symbol: null };
const tokens: readonly SearchToken[] = [
  { chainId: 11155111, address: a("31"), symbol: "USDC", name: "USD Coin" },
  { chainId: 943, address: a("32"), symbol: "USDC.e", name: null },
  { chainId: 943, address: a("33"), symbol: "WETH", name: "Wrapped Ether" },
  { chainId: 943, address: a("34"), symbol: "DAI", name: "Stablecoin USDC alternative" },
];
const update: SearchHeadUpdate = { chainId: 943, slot: "11477760", transactionHash: h("f1") };

const sites = { dapp: "https://next.zkb.fi", indexer: "https://indexer.zkb.fi", status: "https://status.zkb.fi", backend: "https://prove.zkb.fi", gateway: "https://gateway.zkb.fi" };
const base: SearchSources = { sites, chains };
const urlOf = (links: readonly { surface: string; label: string; url: string }[], surface: string): string[] => links.filter((link) => link.surface === surface).map((link) => link.url);

describe("crossLinks", () => {
  const context = { sites, chains };

  it("links a message to the dapp, the indexer, the pipeline check and the backend JSON", () => {
    const links = crossLinks({ type: "message", messageId, direction: "first-to-second" }, context);
    expect(links).toEqual([
      { surface: "dapp", label: "Open in Explore", url: `https://next.zkb.fi/#/message/${messageId}` },
      { surface: "indexer", label: "Indexer", url: `https://indexer.zkb.fi/#lookup=${messageId}` },
      { surface: "status", label: "Status", url: "https://status.zkb.fi/#check=pipeline-first-to-second" },
      { surface: "backend", label: "Backend JSON", url: `https://prove.zkb.fi/progress/${messageId}` },
    ]);
  });

  it("uses the delivery check when the direction is not known", () => {
    expect(urlOf(crossLinks({ type: "message", messageId }, context), "status")).toEqual(["https://status.zkb.fi/#check=pipeline-deliveries"]);
    expect(urlOf(crossLinks({ type: "message", messageId, direction: null }, context), "status")).toEqual(["https://status.zkb.fi/#check=pipeline-deliveries"]);
  });

  it("links a transaction to Explore, the node check and the explorers of its chain", () => {
    const links = crossLinks({ type: "transaction", chainId: 943, hash: sent }, context);
    expect(urlOf(links, "dapp")).toEqual([`https://next.zkb.fi/#/explore/tx/943/${sent}`]);
    expect(urlOf(links, "status")).toEqual(["https://status.zkb.fi/#check=rpc-943"]);
    expect(links.filter((link) => link.surface === "explorer").map((link) => link.label)).toEqual(["PulseChain testnet scan", "Otterscan"]);
    expect(urlOf(links, "explorer")[0]).toBe(`https://scan.v4.testnet.pulsechain.com/#/tx/${sent}`);
  });

  it("links a contract of the deployment to the contract page and its own check", () => {
    const light = crossLinks({ type: "address", address: a("23"), chainId: 943, role: "lightClient" }, context);
    expect(urlOf(light, "dapp")).toEqual([`https://next.zkb.fi/#/explore/contract/943/${a("23")}`]);
    expect(urlOf(light, "status")).toEqual(["https://status.zkb.fi/#check=lightclient-first-to-second"]);
    expect(urlOf(crossLinks({ type: "address", address: a("13"), chainId: 11155111, role: "lightClient" }, context), "status")).toEqual(["https://status.zkb.fi/#check=lightclient-second-to-first"]);
    expect(urlOf(crossLinks({ type: "address", address: a("21"), chainId: 943, role: "bridge" }, context), "status")).toEqual(["https://status.zkb.fi/#check=bridge-943"]);
    expect(urlOf(crossLinks({ type: "address", address: a("14"), chainId: 11155111, role: "gate" }, context), "status")).toEqual(["https://status.zkb.fi/#check=gate-11155111"]);
    expect(urlOf(crossLinks({ type: "address", address: a("22"), chainId: 943, role: "mediator" }, context), "status")).toEqual([]);
    expect(urlOf(light, "explorer")).toHaveLength(2);
  });

  it("links a light client on a chain outside the pair to no check", () => {
    expect(urlOf(crossLinks({ type: "address", address: a("23"), chainId: 5, role: "lightClient" }, context), "status")).toEqual([]);
    expect(directionTo(chains, 5)).toBeNull();
  });

  it("links an address of no known chain to the explorers of every chain and to the address page", () => {
    const links = crossLinks({ type: "address", address: a("99"), chainId: null, role: null }, context);
    expect(urlOf(links, "dapp")).toEqual([`https://next.zkb.fi/#/explore/address/${a("99")}`]);
    expect(urlOf(links, "status")).toEqual([]);
    expect(links.filter((link) => link.surface === "explorer")).toHaveLength(3);
    // A role without a chain is a plain address; a missing chain field is the same.
    expect(urlOf(crossLinks({ type: "address", address: a("99") }, context), "dapp")).toEqual([`https://next.zkb.fi/#/explore/address/${a("99")}`]);
    expect(urlOf(crossLinks({ type: "address", address: a("99"), role: "gate" }, context), "dapp")).toEqual([`https://next.zkb.fi/#/explore/address/${a("99")}`]);
    expect(urlOf(crossLinks({ type: "address", address: a("99"), chainId: 943 }, context), "explorer")).toHaveLength(2);
  });

  it("links a token to its page and the explorer of its chain", () => {
    const links = crossLinks({ type: "token", side: "second", chainId: 943, address: a("32") }, context);
    expect(urlOf(links, "dapp")).toEqual([`https://next.zkb.fi/#/explore/token/second/${a("32")}`]);
    expect(urlOf(links, "indexer")).toEqual([`https://indexer.zkb.fi/#lookup=${a("32")}`]);
    expect(urlOf(links, "status")).toEqual([]);
    expect(urlOf(links, "explorer")).toHaveLength(2);
  });

  it("links a slot to the beacon check of each chain", () => {
    const links = crossLinks({ type: "slot", slot: "11477760" }, context);
    expect(urlOf(links, "dapp")).toEqual(["https://next.zkb.fi/#/explore/slot/11477760"]);
    expect(links.filter((link) => link.surface === "status").map((link) => [link.label, link.url])).toEqual([
      ["Status · Sepolia", "https://status.zkb.fi/#check=beacon-11155111"],
      ["Status · PulseChain testnet v4", "https://status.zkb.fi/#check=beacon-943"],
    ]);
  });

  it("links a block to Explore, the node check and the explorers", () => {
    const links = crossLinks({ type: "block", chainId: 11155111, number: "7" }, context);
    expect(urlOf(links, "dapp")).toEqual(["https://next.zkb.fi/#/explore/block/11155111/7"]);
    expect(urlOf(links, "status")).toEqual(["https://status.zkb.fi/#check=rpc-11155111"]);
    expect(urlOf(links, "explorer")).toEqual(["https://sepolia.etherscan.io/block/7"]);
  });

  it("names a chain that is not in the pair by its number", () => {
    const links = crossLinks({ type: "block", chainId: 5, number: "7" }, context);
    expect(links.map((link) => link.surface)).toEqual(["dapp", "indexer", "status"]);
  });

  it("links a proof to the light client check and the pipeline of its direction", () => {
    const links = crossLinks({ type: "proof", chainId: 943, index: "12" }, context);
    expect(urlOf(links, "dapp")).toEqual(["https://next.zkb.fi/#/explore/proof/943/12"]);
    expect(urlOf(links, "status")).toEqual(["https://status.zkb.fi/#check=lightclient-first-to-second"]);
    expect(urlOf(links, "backend")).toEqual(["https://prove.zkb.fi/directions/first-to-second/pipeline"]);
    const outside = crossLinks({ type: "proof", chainId: 5, index: "12" }, context);
    expect(outside.map((link) => link.surface)).toEqual(["dapp", "indexer"]);
  });

  it("links a release to Explore, the gateway and the gateway check", () => {
    const links = crossLinks({ type: "release", cid: "bafyabc" }, context);
    expect(urlOf(links, "gateway")).toEqual(["https://gateway.zkb.fi/ipfs/bafyabc"]);
    expect(urlOf(links, "status")).toEqual(["https://status.zkb.fi/#check=gateway-next"]);
    expect(urlOf(links, "dapp")).toEqual(["https://next.zkb.fi/#/explore/release/bafyabc"]);
  });

  it("makes relative links for an empty base and leaves out a surface without a base", () => {
    const links = crossLinks({ type: "message", messageId }, { sites: { dapp: "", indexer: "", status: null, backend: undefined }, chains });
    expect(links.map((link) => link.url)).toEqual([`#/message/${messageId}`, `#lookup=${messageId}`]);
    expect(crossLinks({ type: "slot", slot: "1" }, { sites: { dapp: "https://gateway.zkb.fi/ipfs/bafy/", indexer: null }, chains }).map((link) => link.url)).toEqual(["https://gateway.zkb.fi/ipfs/bafy/#/explore/slot/1"]);
  });

  it("exposes the hosts, the surfaces and the role names", () => {
    expect(ZKB_SITES.status).toBe("https://status.zkb.fi");
    expect(DAPP_ORIGINS.gateway).toBe("https://gateway.zkb.fi");
    expect(SEARCH_SURFACES).toContain("explorer");
    expect(CONTRACT_ROLE_NAMES.lightClient).toBe("Light client");
  });
});

describe("lookupTextOf", () => {
  it("gives the text that finds each kind of target again", () => {
    expect(
      [
        lookupTextOf({ type: "message", messageId: "0x1" }),
        lookupTextOf({ type: "transaction", chainId: 1, hash: "0x2" }),
        lookupTextOf({ type: "address", address: "0x3" }),
        lookupTextOf({ type: "token", side: "first", chainId: 1, address: "0x4" }),
        lookupTextOf({ type: "slot", slot: "5" }),
        lookupTextOf({ type: "block", chainId: 1, number: "6" }),
        lookupTextOf({ type: "proof", chainId: 1, index: "7" }),
        lookupTextOf({ type: "release", cid: "bafy8" }),
      ],
    ).toEqual(["0x1", "0x2", "0x3", "0x4", "5", "6", "7", "bafy8"]);
  });
});

describe("searchChainsFromPair", () => {
  it("takes the chains of a pair in order, with a name for each", () => {
    const side = (name: string, chainId: number) => ({ name, chainId, contracts: { bridge: a("01") } });
    const pair = { name: "p", sides: [side("sepolia", 11155111), side("pulse", 943)] } as unknown as Pair;
    expect(PAIR_DEFINITIONS.length).toBeGreaterThan(0);
    const result = searchChainsFromPair(pair, { 943: "Pulse v4" });
    expect(result.map((chain) => [chain.chainId, chain.name, chain.side])).toEqual([[11155111, "Sepolia", "first"], [943, "Pulse v4", "second"]]);
    expect(searchChainsFromPair({ name: "p", sides: [side("a", 5), side("b", 6)] } as unknown as Pair).map((chain) => chain.name)).toEqual(["a", "b"]);
  });
});

describe("resolve: hashes", () => {
  it("finds a message by identifier and reads what it waits on", async () => {
    const sources: SearchSources = {
      ...base,
      indexer: { message: async (id) => (id === messageId ? message : null), messageByTransaction: async () => null },
      backend: { progress: async () => ({ service: "gpu-proving" }) },
    };
    const result = await resolve(messageId, sources);
    expect(result.results.map((entry) => [entry.kind, entry.confirmed])).toEqual([["message", true]]);
    expect(result.results[0]?.subtitle).toBe("Transfer of USDC · waiting for finality · Sepolia to PulseChain testnet v4 · found by identifier · waiting on gpu-proving");
    expect(result.results[0]?.links.map((link) => link.surface)).toEqual(["dapp", "indexer", "status", "backend"]);
    expect(urlOf(result.results[0]?.links ?? [], "status")).toEqual(["https://status.zkb.fi/#check=pipeline-first-to-second"]);
    expect(result.problems).toEqual([]);
  });

  it("leaves out the wait of a message that is done or that the backend does not know, and says a message is a message", async () => {
    const indexer = { message: async () => plain, messageByTransaction: async () => null };
    const done = await resolve(messageId, { ...base, indexer, backend: { progress: async () => ({ service: "none" }) } });
    expect(done.results[0]?.subtitle).toBe("Message · waiting for finality · Sepolia to PulseChain testnet v4 · found by identifier");
    const unknown = await resolve(messageId, { ...base, indexer, backend: { progress: async () => null } });
    expect(unknown.results[0]?.subtitle).not.toContain("waiting on");
  });

  it("keeps the message when the backend fails and reports it", async () => {
    const result = await resolve(messageId, {
      ...base,
      indexer: { message: async () => message, messageByTransaction: async () => null },
      backend: { progress: async () => { throw new Error("down"); } },
    });
    expect(result.results).toHaveLength(1);
    expect(result.problems).toEqual(["backend: unavailable"]);
  });

  it("finds a message by the transaction that sent or delivered it, with the transaction as a second result", async () => {
    const sources: SearchSources = { ...base, indexer: { message: async () => null, messageByTransaction: async () => message } };
    const bySent = await resolve(sent, sources);
    expect(bySent.results.map((entry) => entry.id)).toEqual([`message:${messageId}`, `transaction:11155111:${sent}`]);
    expect(bySent.results[0]?.subtitle).toContain("found by transaction");
    expect(bySent.results[1]?.subtitle).toBe("Send of a transfer · Sepolia");
    const byDelivery = await resolve(delivered, { ...base, indexer: { message: async () => null, messageByTransaction: async () => ({ ...message, kind: "message" }) } });
    expect(byDelivery.results[1]).toMatchObject({ chainId: 943, subtitle: "Delivery of a message · PulseChain testnet v4" });
  });

  it("reads a delivery of a message that was sent from the second chain", async () => {
    const back: SearchMessage = { ...message, sourceChainId: 943, destinationChainId: 11155111, sentTransactionHash: null };
    const result = await resolve(delivered, { ...base, indexer: { message: async () => null, messageByTransaction: async () => back } });
    expect(result.results.map((entry) => entry.id)).toEqual([`message:${messageId}`, `transaction:11155111:${delivered}`]);
    expect(urlOf(result.results[0]?.links ?? [], "status")).toEqual(["https://status.zkb.fi/#check=pipeline-second-to-first"]);
  });

  it("shows a message once when it is found both by identifier and by transaction, and reads one from a chain outside the pair", async () => {
    const both = await resolve(messageId, { ...base, indexer: { message: async () => message, messageByTransaction: async () => message } });
    expect(both.results.filter((entry) => entry.kind === "message")).toHaveLength(1);
    const outside = await resolve(messageId, { ...base, indexer: { message: async () => ({ ...message, sourceChainId: 5 }), messageByTransaction: async () => null } });
    expect(urlOf(outside.results[0]?.links ?? [], "status")).toEqual(["https://status.zkb.fi/#check=pipeline-deliveries"]);
  });

  it("finds a light client update by its transaction", async () => {
    const result = await resolve(update.transactionHash, {
      ...base,
      indexer: { message: async () => null, messageByTransaction: async () => null, headUpdateByTransaction: async () => update },
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ kind: "transaction", confirmed: true, chainId: 943, subtitle: "Light client update to slot 11,477,760 · PulseChain testnet v4" });
  });

  it("offers the hash as a transaction on each chain when nothing knows it", async () => {
    const result = await resolve(h("c0"), { ...base, indexer: { message: async () => null, messageByTransaction: async () => null, headUpdateByTransaction: async () => null } });
    expect(result.results.map((entry) => [entry.chainId, entry.confirmed, entry.subtitle])).toEqual([
      [11155111, false, "If it is on Sepolia"],
      [943, false, "If it is on PulseChain testnet v4"],
    ]);
  });

  it("confirms the chain that has the transaction and drops the guess on the other chain", async () => {
    const result = await resolve(h("c0"), { ...base, chain: { transaction: async (chainId) => chainId === 943 } });
    expect(result.results.map((entry) => [entry.chainId, entry.confirmed, entry.subtitle])).toEqual([[943, true, "On PulseChain testnet v4"]]);
  });

  it("reports a node that fails and goes on", async () => {
    const result = await resolve(h("c0"), { ...base, chain: { transaction: async (chainId) => { if (chainId === 943) throw new Error("timeout"); return true; } } });
    expect(result.problems).toEqual(["PulseChain testnet v4 node: unavailable"]);
    expect(result.results.map((entry) => entry.chainId)).toEqual([11155111]);
  });

  it("does not guess on every chain for a hash that is a message", async () => {
    const result = await resolve(messageId, { ...base, indexer: { message: async () => message, messageByTransaction: async () => null } });
    expect(result.results.map((entry) => entry.kind)).toEqual(["message"]);
  });

  it("reports an indexer that fails", async () => {
    const result = await resolve(messageId, { ...base, indexer: { message: async () => { throw new Error("503"); }, messageByTransaction: async () => { throw "bad"; } } });
    expect(result.problems).toEqual(["indexer: unavailable", "indexer: unavailable"]);
    expect(result.results).toHaveLength(2);
  });

  it("answers without any reader", async () => {
    const result = await resolve(messageId, base);
    expect(result.results.map((entry) => entry.kind)).toEqual(["transaction", "transaction"]);
  });
});

describe("resolve: errors", () => {
  it("never puts the text of a reader's error in the answer, and hands it to onError", async () => {
    const secret = "fetch failed: https://rpc.example/v1/KEY123456 (key=abc)";
    const seen: [string, unknown][] = [];
    const result = await resolve(messageId, { ...base, indexer: { message: async () => { throw new Error(secret); }, messageByTransaction: async () => { throw secret; } } }, { onError: (label, error) => seen.push([label, error]) });
    expect(JSON.stringify(result)).not.toContain("KEY123456");
    expect(JSON.stringify(result)).not.toContain("rpc.example");
    expect(result.problems).toEqual(["indexer: unavailable", "indexer: unavailable"]);
    expect(seen.map(([label]) => label)).toEqual(["indexer", "indexer"]);
    expect(String(seen[0]?.[1])).toContain("KEY123456");
  });
});

describe("resolve: addresses", () => {
  it("names a contract of the deployment on its chain", async () => {
    const result = await resolve(a("23").toUpperCase().replace("0X", "0x"), base);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ kind: "address", addressType: "lightClient", chainId: 943, title: "Light client on PulseChain testnet v4", confirmed: true });
    expect(urlOf(result.results[0]?.links ?? [], "status")).toEqual(["https://status.zkb.fi/#check=lightclient-first-to-second"]);
  });

  it("names a bridged token and a contract in one go", async () => {
    const shared = a("ee");
    const sources: SearchSources = {
      sites,
      chains: [{ ...chains[0] as SearchChain, contracts: { bridge: shared } }, chains[1] as SearchChain],
      indexer: { message: async () => null, messageByTransaction: async () => null, tokens: async () => [{ chainId: 943, address: shared, symbol: "TKN", name: null }] },
    };
    const result = await resolve(shared, sources);
    expect(result.results.map((entry) => entry.kind)).toEqual(["address", "token"]);
  });

  it("calls an address an account, a contract or unknown, and counts its transfers", async () => {
    const account = a("99");
    const make = (answers: Record<number, boolean | Error>, count?: number | Error): SearchSources => ({
      ...base,
      chain: { isContract: async (chainId) => { const answer = answers[chainId]; if (answer instanceof Error) throw answer; return answer === true; } },
      indexer: { message: async () => null, messageByTransaction: async () => null, ...(count === undefined ? {} : { transferCount: async () => { if (count instanceof Error) throw count; return count; } }) },
    });
    expect((await resolve(account, make({ 11155111: false, 943: false }, 3))).results[0]).toMatchObject({ addressType: "account", subtitle: "Account · 3 transfers · its transfers and balances", chainId: null });
    expect((await resolve(account, make({ 11155111: false, 943: true }, 1))).results[0]).toMatchObject({ addressType: "contract", subtitle: "Contract · 1 transfer · its transfers and balances" });
    const failing = await resolve(account, make({ 11155111: new Error("x"), 943: false }, new Error("y")));
    expect(failing.results[0]).toMatchObject({ addressType: "unknown", subtitle: "Address · its transfers and balances" });
    expect(failing.problems).toEqual(["Sepolia node: unavailable", "indexer: unavailable"]);
    expect((await resolve(account, base)).results[0]).toMatchObject({ addressType: "unknown" });
  });
});

describe("resolve: prefixes", () => {
  it("finds contracts, tokens and messages that start with the text", async () => {
    const sources: SearchSources = {
      ...base,
      indexer: { message: async () => null, messageByTransaction: async () => null, tokens: async () => tokens, messagesByPrefix: async (prefix) => (message.messageId.startsWith(prefix) ? [message] : []) },
    };
    const result = await resolve("0x222222", sources);
    expect(result.results.map((entry) => entry.kind)).toEqual(["address"]);
    const tokenPrefix = await resolve("0x313131", sources);
    expect(tokenPrefix.results.map((entry) => entry.kind)).toEqual(["token"]);
    const messagePrefix = await resolve(messageId.slice(0, 12), sources);
    expect(messagePrefix.results.map((entry) => entry.kind)).toEqual(["message"]);
    expect(messagePrefix.results[0]?.subtitle).toContain("found by identifier start");
  });

  it("finds nothing without readers", async () => {
    expect((await resolve("0xabcdef", base)).results).toEqual([]);
  });

  it("limits what a short prefix returns", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ chainId: 943, address: `0xaaaaaa${index.toString(16).padStart(34, "0")}`, symbol: `T${index}`, name: null }));
    const result = await resolve("0xaaaaaa", { ...base, indexer: { message: async () => null, messageByTransaction: async () => null, tokens: async () => many } });
    expect(result.results).toHaveLength(10);
  });
});

describe("resolve: token symbols and names", () => {
  const sources: SearchSources = { ...base, indexer: { message: async () => null, messageByTransaction: async () => null, tokens: async () => tokens } };

  it("ranks an exact symbol, then a prefix, then a substring of a symbol or a name", async () => {
    const result = await resolve("usdc", sources);
    expect(result.results.map((entry) => entry.title)).toEqual(["USDC", "USDC.e", "DAI"]);
    expect(result.results[0]).toMatchObject({ kind: "token", chainId: 11155111, target: { type: "token", side: "first", chainId: 11155111, address: a("31") } });
    expect(result.results[0]?.subtitle).toBe(`Sepolia · ${a("31")} · USD Coin`);
    expect(result.results[1]?.subtitle).toBe(`PulseChain testnet v4 · ${a("32")}`);
  });

  it("puts a token of a chain outside the pair on the first side, named by its number", async () => {
    const outside = await resolve("zzz", { ...base, indexer: { message: async () => null, messageByTransaction: async () => null, tokens: async () => [{ chainId: 5, address: a("51"), symbol: "ZZZ", name: null }] } });
    expect(outside.results[0]).toMatchObject({ subtitle: `chain 5 · ${a("51")}`, target: { side: "first" } });
  });

  it("matches a name, with the sides of the chains", async () => {
    const result = await resolve("wrapped ether", sources);
    expect(result.results.map((entry) => entry.title)).toEqual(["WETH"]);
    expect(result.results[0]?.target).toMatchObject({ side: "second" });
  });

  it("breaks ties by symbol, chain and address, so the order never changes", async () => {
    const same: SearchToken[] = [
      { chainId: 943, address: a("42"), symbol: "AAA", name: null },
      { chainId: 11155111, address: a("41"), symbol: "AAA", name: null },
      { chainId: 11155111, address: a("40"), symbol: "AAA", name: null },
      { chainId: 11155111, address: a("43"), symbol: "AAB", name: null },
    ];
    const result = await resolve("aa", { ...base, indexer: { message: async () => null, messageByTransaction: async () => null, tokens: async () => same } });
    expect(result.results.map((entry) => entry.id)).toEqual([`token:943:${a("42")}`, `token:11155111:${a("40")}`, `token:11155111:${a("41")}`, `token:11155111:${a("43")}`]);
  });

  it("limits the tokens and finds none without a reader", async () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ chainId: 943, address: a(index.toString(16).padStart(2, "0")), symbol: `TOK${index}`, name: null }));
    expect((await resolve("tok", { ...base, indexer: { message: async () => null, messageByTransaction: async () => null, tokens: async () => many } })).results).toHaveLength(8);
    expect((await resolve("tok", base)).results).toEqual([]);
  });
});

describe("resolve: numbers", () => {
  it("offers proofs, a slot and a block on each chain, shaped but not confirmed", async () => {
    const result = await resolve("1,0".replace(",", ""), base);
    expect(result.results.map((entry) => [entry.kind, entry.chainId, entry.confirmed])).toEqual([
      ["proof", 11155111, false],
      ["proof", 943, false],
      ["slot", null, false],
      ["block", 11155111, false],
      ["block", 943, false],
    ]);
  });

  it("confirms a slot that a light client update used, and a block that a node has", async () => {
    const result = await resolve("11477760", {
      ...base,
      indexer: { message: async () => null, messageByTransaction: async () => null, headUpdatesBySlot: async () => [update] },
      chain: { block: async (chainId) => chainId === 943 },
    });
    expect(result.results.map((entry) => [entry.kind, entry.chainId, entry.confirmed])).toEqual([
      ["slot", null, true],
      ["block", 943, true],
      ["proof", 11155111, false],
      ["proof", 943, false],
      ["block", 11155111, false],
    ]);
    expect(result.results[0]).toMatchObject({ title: "Slot 11,477,760", subtitle: "Beacon chain · light client update on PulseChain testnet v4" });
  });

  it("leaves a slot unconfirmed when no update has it, and reports a failing node", async () => {
    const result = await resolve("7", {
      ...base,
      indexer: { message: async () => null, messageByTransaction: async () => null, headUpdatesBySlot: async () => [] },
      chain: { block: async () => { throw new Error("late"); } },
    });
    expect(result.results.find((entry) => entry.kind === "slot")).toMatchObject({ confirmed: false, subtitle: "Beacon chain" });
    expect(result.problems).toEqual(["Sepolia node: unavailable", "PulseChain testnet v4 node: unavailable"]);
  });

  it("lists only the proofs that the page has loaded when it has any source of them", async () => {
    const proofs = { matching: async (value: string) => (value === "12" ? [{ chainId: 943, number: "12", slot: "11477760" }] : []) };
    const found = await resolve("12", { ...base, proofs });
    expect(found.results.filter((entry) => entry.kind === "proof")).toHaveLength(1);
    expect(found.results[0]).toMatchObject({ kind: "proof", confirmed: true, subtitle: "Slot 11,477,760 · light client update on PulseChain testnet v4", title: "Proof #12" });
    expect((await resolve("13", { ...base, proofs })).results.some((entry) => entry.kind === "proof")).toBe(false);
    const broken = await resolve("12", { ...base, proofs: { matching: async () => { throw new Error("no board"); } } });
    expect(broken.problems).toEqual(["proofs: unavailable"]);
  });

  it("offers proofs only on chains that hold a light client", async () => {
    const result = await resolve("5", { sites, chains: [{ ...(chains[0] as SearchChain), contracts: {} }, { ...(chains[1] as SearchChain), contracts: { lightClient: null } }] });
    expect(result.results.some((entry) => entry.kind === "proof")).toBe(false);
  });
});

describe("resolve: release, names and the limit", () => {
  it("offers a release for a CID", async () => {
    const cid = `bafy${"a".repeat(30)}`;
    const result = await resolve(cid, base);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ kind: "release", confirmed: false, target: { type: "release", cid } });
  });

  it("says that a name is not resolved", async () => {
    const result = await resolve("vitalik.eth", base);
    expect(result).toMatchObject({ unsupported: "name", results: [] });
  });

  it("returns nothing for an empty text and honours the limit", async () => {
    expect((await resolve("", base)).results).toEqual([]);
    expect((await resolve("9", base, { limit: 2 })).results).toHaveLength(2);
  });

  it("ranks an exact identifier above an address, a symbol and a number, found above shaped", async () => {
    const result = await resolve("5", { ...base, chain: { block: async (chainId) => chainId === 943 } });
    expect(result.results.map((entry) => entry.rank)).toEqual([...result.results.map((entry) => entry.rank)].sort((x, y) => x - y));
    expect(result.results[0]?.id).toBe("block:943:5");
  });

  it("returns the same order every time", async () => {
    const first = await resolve("5", base);
    const second = await resolve("5", base);
    expect(second.results.map((entry) => entry.id)).toEqual(first.results.map((entry) => entry.id));
  });
});
