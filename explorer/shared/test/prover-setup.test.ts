import { describe, expect, it } from "vitest";
import {
  assertEndpointUrl,
  emptyProverSetup,
  parseProverSetup,
  parseReferenceText,
  ProverSetupError,
  referenceText,
  SECRET_NAMES,
} from "../src/config/index.js";

const valid = () => JSON.parse(JSON.stringify(emptyProverSetup()));

describe("emptyProverSetup", () => {
  it("starts with both directions, an hourly policy and no secrets", () => {
    expect(emptyProverSetup()).toEqual({
      schemaVersion: 1,
      endpointUrl: "",
      runpodApiKey: null,
      chains: {},
      msgboardUrl: null,
      pair: "eth-pls",
      directions: ["first-to-second", "second-to-first"],
      policy: { proveWhenTransferWaits: true, intervalSeconds: 3600 },
    });
  });
});

describe("parseProverSetup", () => {
  it("accepts the empty setup", () => {
    expect(parseProverSetup(valid())).toEqual(emptyProverSetup());
  });

  it("parses references of all three sources and per chain endpoints", () => {
    const input = valid();
    input.runpodApiKey = { source: "store", name: "k" };
    input.msgboardUrl = { source: "environment", variable: "MSG" };
    input.endpointUrl = "https://abc.api.runpod.ai";
    input.chains = { "1": { rpc: { source: "onepassword", reference: "op://v/i/f" }, beacon: null }, "369": {} };
    expect(parseProverSetup(input)).toMatchObject({
      runpodApiKey: { source: "store", name: "k" },
      msgboardUrl: { source: "environment", variable: "MSG" },
      endpointUrl: "https://abc.api.runpod.ai",
      chains: {
        "1": { rpc: { source: "onepassword", reference: "op://v/i/f" }, beacon: null },
        "369": { rpc: null, beacon: null },
      },
    });
  });

  it("parses an optional reference to the state URLs of a chain, and refuses a value", () => {
    const input = valid();
    input.chains = { "943": { rpc: null, beacon: null, stateUrls: { source: "environment", variable: "EXPLORER_STATE_URLS_943" } }, "1": {} };
    const parsed = parseProverSetup(input);
    expect(parsed.chains["943"]?.stateUrls).toEqual({ source: "environment", variable: "EXPLORER_STATE_URLS_943" });
    expect(parsed.chains["1"]?.stateUrls).toBeUndefined();
    input.chains = { "943": { stateUrls: "https://states.example.org" } };
    expect(() => parseProverSetup(input)).toThrow(/setup.chains.943.stateUrls/);
  });

  it("treats a missing chains field as no chains", () => {
    const input = valid();
    delete input.chains;
    expect(parseProverSetup(input).chains).toEqual({});
  });

  it("reads proveWhenTransferWaits as true only for the value true", () => {
    const input = valid();
    input.policy.proveWhenTransferWaits = "yes";
    expect(parseProverSetup(input).policy.proveWhenTransferWaits).toBe(false);
  });

  it.each([
    ["a non object", "text", "setup must be an object."],
    ["an array", [], "setup must be an object."],
    ["a wrong schema version", { ...valid(), schemaVersion: 2 }, "setup.schemaVersion must be 1."],
    ["a non text endpoint", { ...valid(), endpointUrl: 5 }, "setup.endpointUrl must be text."],
    ["a non text pair", { ...valid(), pair: 5 }, "setup.pair must be text."],
    ["a non list of directions", { ...valid(), directions: "x" }, "setup.directions must be a list."],
    ["an unknown direction", { ...valid(), directions: ["sideways"] }, "setup.directions holds only first-to-second and second-to-first."],
    ["a fractional interval", { ...valid(), policy: { intervalSeconds: 1.5 } }, "setup.policy.intervalSeconds must be a whole number"],
    ["a negative interval", { ...valid(), policy: { intervalSeconds: -1 } }, "setup.policy.intervalSeconds must be a whole number"],
    ["a text interval", { ...valid(), policy: { intervalSeconds: "5" } }, "setup.policy.intervalSeconds must be a whole number"],
    ["a missing policy", { ...valid(), policy: undefined }, "setup.policy must be an object."],
    ["a chain key that is not a number", { ...valid(), chains: { eth: {} } }, 'setup.chains key "eth" is not a chain identifier.'],
    ["a chain entry that is not an object", { ...valid(), chains: { "1": 3 } }, "setup.chains.1 must be an object."],
    ["a secret value in place of a reference", { ...valid(), msgboardUrl: { source: "store", name: 5 } }, "setup.msgboardUrl must be a reference"],
    ["an unknown reference source", { ...valid(), runpodApiKey: { source: "plain", value: "x" } }, "setup.runpodApiKey must be a reference"],
    ["an insecure endpoint", { ...valid(), endpointUrl: "http://example.com" }, "must use https"],
  ])("refuses %s", (_name, input, message) => {
    expect(() => parseProverSetup(input)).toThrow(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(() => parseProverSetup(input)).toThrow(ProverSetupError);
  });
});

describe("assertEndpointUrl", () => {
  it.each(["https://a.example", "http://localhost:8080", "http://127.0.0.1", "http://[::1]:3"])("accepts %s", (url) => {
    expect(() => assertEndpointUrl(url)).not.toThrow();
  });

  it("refuses text that is not a URL", () => {
    expect(() => assertEndpointUrl("not a url")).toThrow("The endpoint URL is not a URL.");
  });

  it("refuses http on a remote host and other schemes", () => {
    expect(() => assertEndpointUrl("http://a.example")).toThrow("must use https");
    expect(() => assertEndpointUrl("ftp://localhost")).toThrow("must use https");
  });

  it("refuses credentials and a query", () => {
    expect(() => assertEndpointUrl("https://u:p@a.example")).toThrow("must not hold credentials or a query");
    expect(() => assertEndpointUrl("https://u@a.example")).toThrow("must not hold credentials or a query");
    expect(() => assertEndpointUrl("https://a.example/?key=1")).toThrow("must not hold credentials or a query");
  });
});

describe("SECRET_NAMES", () => {
  it("builds the names of the chain secrets from a number or text identifier", () => {
    expect(SECRET_NAMES.chainRpc(369)).toBe("explorer.prover.chain.369.rpc");
    expect(SECRET_NAMES.chainBeacon("1")).toBe("explorer.prover.chain.1.beacon");
    expect(SECRET_NAMES.runpodApiKey).toBe("explorer.prover.runpod-api-key");
    expect(SECRET_NAMES.msgboardUrl).toBe("explorer.prover.msgboard-url");
  });
});

describe("parseReferenceText", () => {
  it("reads a 1Password reference and trims it", () => {
    expect(parseReferenceText("  op://vault/item/field ")).toEqual({ source: "onepassword", reference: "op://vault/item/field" });
  });

  it("refuses a malformed 1Password reference", () => {
    expect(() => parseReferenceText("op://vault/item")).toThrow("looks like op://vault/item/field");
  });

  it("reads an environment reference", () => {
    expect(parseReferenceText("env:MY_KEY_1")).toEqual({ source: "environment", variable: "MY_KEY_1" });
  });

  it("refuses an environment name that is not an identifier", () => {
    expect(() => parseReferenceText("env:1BAD")).toThrow("letters, digits and underscores");
  });

  it("refuses a bare secret", () => {
    expect(() => parseReferenceText("rpa_secretvalue")).toThrow("To type a secret, use the secret field.");
  });
});

describe("referenceText", () => {
  it("shows each source in its text form", () => {
    expect(referenceText({ source: "store", name: "n" })).toBe("stored (n)");
    expect(referenceText({ source: "environment", variable: "V" })).toBe("env:V");
    expect(referenceText({ source: "onepassword", reference: "op://a/b/c" })).toBe("op://a/b/c");
  });
});
