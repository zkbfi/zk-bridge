import { describe, expect, it } from "vitest";
import { defaultBeaconUrl } from "@terminal/config/default-beacon";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { EMPTY_CONNECTION_SETTINGS } from "@zk-bridge/shared";
import { currentValues, defaultValues, fieldProblem, pageProtocolOf, settingFields, settingsFromDrafts, textOf } from "../../src/app/settings-model";
import { readConfiguration } from "../../src/config/environment";
import { FIRST_CHAIN, SECOND_CHAIN, liveConfiguration, sharedPairForTests } from "../support/live";

const fields = settingFields(FIXTURE_PAIR);
const fixture = readConfiguration({ VITE_EXPLORER_DATA: "fixture" });
const field = (id: string) => fields.find((candidate) => candidate.id === id)!;
const GIB = "https://gib.show/image/{chainId}/{address}";

describe("the fields of the settings", () => {
  it("lists an RPC per chain, the image server, then every other service, each with its own check", () => {
    expect(fields.map((candidate) => candidate.id)).toEqual([
      `rpc:${FIRST_CHAIN}`,
      `rpc:${SECOND_CHAIN}`,
      `beacon:${FIRST_CHAIN}`,
      `beacon:${SECOND_CHAIN}`,
      "images",
      "indexer",
      "backendUrl",
      "archiveUrl",
      "msgboardIndexerUrl",
      `board:${FIRST_CHAIN}`,
      `board:${SECOND_CHAIN}`,
    ]);
    expect(fields.map((candidate) => candidate.probe.kind)).toEqual(["rpc", "rpc", "beacon", "beacon", "image", "health", "health", "health", "health", "jsonrpc", "jsonrpc"]);
  });

  it("gives a beacon API to each chain (owner: 'configure different beacon endpoints in the settings'), with its icon and a genesis check of that chain", () => {
    expect(field(`beacon:${FIRST_CHAIN}`)).toMatchObject({ section: "beacon", chainId: FIRST_CHAIN, probe: { kind: "beacon", chainId: FIRST_CHAIN }, target: { kind: "beacon", chainId: FIRST_CHAIN } });
    expect(field(`beacon:${SECOND_CHAIN}`).probe).toEqual({ kind: "beacon", chainId: SECOND_CHAIN });
  });

  it("gives a msgboard node to each chain (owner, quote 87), with its icon and a check that names the chain", () => {
    expect(field(`board:${FIRST_CHAIN}`)).toMatchObject({ section: "boards", chainId: FIRST_CHAIN, probe: { kind: "jsonrpc", chainId: FIRST_CHAIN }, target: { kind: "board", chainId: FIRST_CHAIN } });
    expect(field(`board:${SECOND_CHAIN}`).probe).toEqual({ kind: "jsonrpc", chainId: SECOND_CHAIN });
    expect(fields.some((candidate) => candidate.id === "msgboardUrl")).toBe(false);
  });
});

describe("the msgboard nodes", () => {
  const live = liveConfiguration({ VITE_EXPLORER_MSGBOARD_URL: "https://board.zkb.fi" });
  const defaults = defaultValues({ fields, pair: FIXTURE_PAIR, configuration: live, sharedPair: sharedPairForTests() });

  it("default to the build's single node on each chain", () => {
    expect(defaults[`board:${FIRST_CHAIN}`]).toBe("https://board.zkb.fi");
    expect(defaults[`board:${SECOND_CHAIN}`]).toBe("https://board.zkb.fi");
  });

  it("show a saved single node on both chains, and saving moves it to each chain", () => {
    const user = { ...EMPTY_CONNECTION_SETTINGS, msgboardUrl: "https://old.example.org" };
    const current = currentValues(fields, defaults, user, GIB);
    expect(current[`board:${FIRST_CHAIN}`]).toBe("https://old.example.org");
    expect(current[`board:${SECOND_CHAIN}`]).toBe("https://old.example.org");
    // Set one chain back to the default: it really returns to it, the other keeps the old node.
    const drafts = { ...current, [`board:${FIRST_CHAIN}`]: "https://board.zkb.fi" };
    const outcome = settingsFromDrafts({ fields, drafts, defaults, user, pageProtocol: "https:" });
    expect(outcome.problems).toEqual({});
    expect(outcome.user.msgboardUrl).toBeNull();
    expect(outcome.user.msgboardUrls).toEqual({ [SECOND_CHAIN]: "https://old.example.org" });
  });

  it("let two chains share one URL", () => {
    const drafts = { ...currentValues(fields, defaults, EMPTY_CONNECTION_SETTINGS, GIB), [`board:${FIRST_CHAIN}`]: "https://same.example.org", [`board:${SECOND_CHAIN}`]: "https://same.example.org" };
    const outcome = settingsFromDrafts({ fields, drafts, defaults, user: EMPTY_CONNECTION_SETTINGS, pageProtocol: "https:" });
    expect(outcome.user.msgboardUrls).toEqual({ [FIRST_CHAIN]: "https://same.example.org", [SECOND_CHAIN]: "https://same.example.org" });
  });
});

describe("the beacon APIs", () => {
  it("default to each chain's first default beacon API, on the sample page and on a live page", () => {
    const sample = defaultValues({ fields, pair: FIXTURE_PAIR, configuration: fixture });
    expect(sample[`beacon:${FIRST_CHAIN}`]).toBe(defaultBeaconUrl(FIRST_CHAIN));
    expect(sample[`beacon:${FIRST_CHAIN}`]).toBe(defaultBeaconUrl(FIRST_CHAIN));
    const live = defaultValues({ fields, pair: FIXTURE_PAIR, configuration: liveConfiguration({}), sharedPair: sharedPairForTests() });
    expect(live[`beacon:${SECOND_CHAIN}`]).toBe(defaultBeaconUrl(SECOND_CHAIN));
  });

  it("take the build's beacon API over the default", () => {
    const configuration = liveConfiguration({ [`VITE_EXPLORER_BEACON_URL_${SECOND_CHAIN}`]: "https://beacon.build.example.org" });
    const defaults = defaultValues({ fields, pair: FIXTURE_PAIR, configuration, sharedPair: sharedPairForTests() });
    expect(defaults[`beacon:${SECOND_CHAIN}`]).toBe("https://beacon.build.example.org");
  });

  it("show the user's beacon API, keep a changed one, and drop one set back to the default", () => {
    const defaults = defaultValues({ fields, pair: FIXTURE_PAIR, configuration: fixture });
    const user = { ...EMPTY_CONNECTION_SETTINGS, beaconUrls: { [FIRST_CHAIN]: "https://old-beacon.example.org" } };
    const shown = currentValues(fields, defaults, user, GIB);
    expect(shown[`beacon:${FIRST_CHAIN}`]).toBe("https://old-beacon.example.org");
    const drafts = { ...shown, [`beacon:${FIRST_CHAIN}`]: defaults[`beacon:${FIRST_CHAIN}`]!, [`beacon:${SECOND_CHAIN}`]: "https://rpc-pulsechain.g4mm4.io/beacon-api/" };
    const outcome = settingsFromDrafts({ fields, drafts, defaults, user, pageProtocol: "https:" });
    expect(outcome.problems).toEqual({});
    expect(outcome.user.beaconUrls).toEqual({ [SECOND_CHAIN]: "https://rpc-pulsechain.g4mm4.io/beacon-api" });
  });

  it("refuse a beacon API that is not a URL, and an empty one while a default exists", () => {
    expect(fieldProblem(field(`beacon:${FIRST_CHAIN}`), "beacon", "https://d.example.org")).toMatch(/not a URL/);
    expect(fieldProblem(field(`beacon:${FIRST_CHAIN}`), "", "https://d.example.org")).toBe("Enter a URL, or reset to the default.");
  });
});

describe("the defaults", () => {
  it("are the default public RPC, the standard indexer, gib.show and nothing for an unset service on the sample page", () => {
    const defaults = defaultValues({ fields, pair: FIXTURE_PAIR, configuration: fixture });
    expect(defaults[`rpc:${FIRST_CHAIN}`]).toBe(defaultRpcUrl(FIRST_CHAIN));
    expect(defaults.indexer).toBe("http://localhost:42069");
    expect(defaults.images).toBe(GIB);
    expect(defaults.backendUrl).toBe("");
  });

  it("take the build's values first, then the deployment's", () => {
    const configuration = liveConfiguration({ VITE_EXPLORER_INDEXER_URL: "https://indexer.zkb.fi", VITE_EXPLORER_BACKEND_URL: "https://prove.zkb.fi" });
    const defaults = defaultValues({ fields, pair: FIXTURE_PAIR, configuration, sharedPair: sharedPairForTests() });
    expect(defaults.indexer).toBe("https://indexer.zkb.fi");
    expect(defaults.backendUrl).toBe("https://prove.zkb.fi");
    expect(defaults[`rpc:${SECOND_CHAIN}`]).toBe("https://registry.example.org/pls");
  });

  it("give way to the user's settings in what the fields show", () => {
    const defaults = defaultValues({ fields, pair: FIXTURE_PAIR, configuration: fixture });
    const shown = currentValues(fields, defaults, { indexerUrl: "https://mine.example.org", rpcUrls: { [SECOND_CHAIN]: "https://rpc.example.org" }, archiveUrl: "https://a.example.org" }, "https://img.example.org/{chainId}/{address}");
    expect(shown.indexer).toBe("https://mine.example.org");
    expect(shown[`rpc:${SECOND_CHAIN}`]).toBe("https://rpc.example.org");
    expect(shown[`rpc:${FIRST_CHAIN}`]).toBe(defaults[`rpc:${FIRST_CHAIN}`]);
    expect(shown.archiveUrl).toBe("https://a.example.org");
    expect(shown.images).toBe("https://img.example.org/{chainId}/{address}");
  });
});

describe("a typed value", () => {
  it("is checked by the rule of its kind", () => {
    expect(fieldProblem(field("images"), "http://img.example.org/{chainId}/{address}", GIB)).toBe("Use an https:// address.");
    expect(fieldProblem(field(`rpc:${FIRST_CHAIN}`), "ftp://x", "https://d")).toMatch(/must start with http/);
    expect(fieldProblem(field("indexer"), "", "http://localhost:42069")).toBe("Enter a URL, or reset to the default.");
    expect(fieldProblem(field("archiveUrl"), "", "")).toBeNull();
    expect(fieldProblem(field("archiveUrl"), "https://a.example.org/?x=1", "")).toMatch(/query/);
    expect(fieldProblem(field("archiveUrl"), "https://a.example.org/", "")).toBeNull();
  });
});

describe("the settings that the typed values make", () => {
  const defaults = defaultValues({ fields, pair: FIXTURE_PAIR, configuration: fixture });

  it("keeps a changed value, drops a value equal to its default, and keeps a changed image server", () => {
    const drafts = { ...defaults, indexer: "https://mine.example.org/", [`rpc:${FIRST_CHAIN}`]: defaults[`rpc:${FIRST_CHAIN}`]!, archiveUrl: "https://a.example.org/", images: "https://img.example.org/{chainId}/{address}" };
    const user = { ...EMPTY_CONNECTION_SETTINGS, rpcUrls: { [FIRST_CHAIN]: "https://old.example.org" } };
    const outcome = settingsFromDrafts({ fields, drafts, defaults, user, pageProtocol: "https:" });
    expect(outcome.problems).toEqual({});
    expect(outcome.user.indexerUrl).toBe("https://mine.example.org");
    expect(outcome.user.rpcUrls).toEqual({});
    expect(outcome.user.archiveUrl).toBe("https://a.example.org");
    expect(outcome.imageServer).toBe("https://img.example.org/{chainId}/{address}");
    expect(outcome.insecure).toEqual([]);
  });

  it("clears a service that was emptied, names plain http on an https page, and gives null for the default image server", () => {
    const drafts = { ...defaults, archiveUrl: "", backendUrl: "http://prove.example.org" };
    const outcome = settingsFromDrafts({ fields, drafts, defaults, user: { ...EMPTY_CONNECTION_SETTINGS, archiveUrl: "https://a.example.org" }, pageProtocol: "https:" });
    expect(outcome.user.archiveUrl).toBeNull();
    expect(outcome.user.backendUrl).toBe("http://prove.example.org");
    expect(outcome.insecure).toEqual(["Prover"]);
    expect(outcome.imageServer).toBeNull();
  });

  it("reports each field that is not usable and leaves the stored value as it was", () => {
    const user = { ...EMPTY_CONNECTION_SETTINGS, indexerUrl: "https://kept.example.org" };
    const outcome = settingsFromDrafts({ fields, drafts: { ...defaults, indexer: "not a url", images: "nope" }, defaults, user, pageProtocol: "http:" });
    expect(Object.keys(outcome.problems)).toEqual(["images", "indexer"]);
    expect(outcome.user.indexerUrl).toBe("https://kept.example.org");
  });
});

describe("small helpers", () => {
  it("reads a missing field as empty text, and the page protocol as http unless it is https", () => {
    expect(textOf({}, "indexer")).toBe("");
    expect(textOf({ indexer: "x" }, "indexer")).toBe("x");
    expect(pageProtocolOf("https:")).toBe("https:");
    expect(pageProtocolOf("file:")).toBe("http:");
  });

  it("treats a field the drafts leave out as empty", () => {
    const defaults = defaultValues({ fields, pair: FIXTURE_PAIR, configuration: fixture });
    const outcome = settingsFromDrafts({ fields, drafts: {}, defaults: {}, user: EMPTY_CONNECTION_SETTINGS, pageProtocol: "http:" });
    expect(outcome.problems).toEqual({ images: "This is not a URL." });
    expect(Object.keys(settingsFromDrafts({ fields, drafts: {}, defaults, user: EMPTY_CONNECTION_SETTINGS, pageProtocol: "http:" }).problems)).toContain("indexer");
  });
});
