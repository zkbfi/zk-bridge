import { describe, expect, it } from "vitest";
import { StatusConfigError, loadStatusPair, parseStatusConfig, resolveReference, secretValues } from "../src/config.ts";

const deployment = {
  chain_a: { chain_id: 11155111, bridge: "0x" + "1".repeat(40), mediator: "0x" + "2".repeat(40), token_factory: "0x" + "3".repeat(40), wrapped_native: "0x" + "4".repeat(40), gate: "0x" + "5".repeat(40), light_client: "0x" + "6".repeat(40), start_block: 1 },
  chain_b: { chain_id: 943, bridge: "0x" + "a".repeat(40), mediator: "0x" + "b".repeat(40), token_factory: "0x" + "c".repeat(40), wrapped_native: "0x" + "d".repeat(40), gate: "0x" + "e".repeat(40), light_client: "0x" + "f".repeat(40), start_block: 2 },
};

const base = {
  schemaVersion: 1,
  databasePath: "/tmp/status.sqlite",
  pair: "sepolia-pls943",
  deploymentFile: "/tmp/deployment.json",
  chains: {
    "11155111": { label: "Sepolia", symbol: "ETH", rpcUrl: "env:RPC_A", beaconUrl: "env:BEACON_A" },
    "943": { label: "PulseChain testnet", symbol: "tPLS", rpcUrl: "https://rpc.example.org/key", beaconUrl: "https://beacon.example.org" },
  },
  runpod: { endpointId: "abc123", apiKey: "env:RUNPOD_API_KEY" },
  wallets: [{ name: "runner", address: "0x" + "9".repeat(40), low: { "11155111": "0.05", "943": "1000" } }],
};
const environment = { RPC_A: "https://sepolia.example.org/secretkey", BEACON_A: "https://beacon-a.example.org/k", RUNPOD_API_KEY: "rp_secret_value" };

describe("runpod section", () => {
  const parse = (runpod: unknown) => parseStatusConfig(JSON.stringify({ ...base, runpod })).runpod;
  it("reads endpoints with labels, a list of ids, and the old single id, merged, label defaulting to the id", () => {
    expect(parse({ endpoints: [{ id: "a1", label: "gpu-24gb" }], endpointIds: ["b2"], endpointId: "c3", apiKey: "k" })).toEqual({
      endpoints: [{ id: "a1", label: "gpu-24gb" }, { id: "b2", label: "b2" }, { id: "c3", label: "c3" }],
      apiKey: "k",
      restUrl: "https://api.runpod.io/v2",
      graphqlUrl: undefined,
      apiBase: undefined,
    });
  });
  it("takes the REST v2 address from restUrl", () => {
    expect(parse({ endpointIds: ["a1"], apiKey: "k", restUrl: "https://example.org/v2" })).toMatchObject({ restUrl: "https://example.org/v2" });
    expect(() => parse({ endpointIds: ["a1"], apiKey: "k", restUrl: "not a url" })).toThrow();
  });
  it("still accepts the old REST apiBase and graphqlUrl, which are ignored with a warning", () => {
    expect(parse({ endpointId: "a1", apiKey: "k", apiBase: "https://rest.runpod.io/v1" })).toMatchObject({ apiBase: "https://rest.runpod.io/v1" });
    expect(parse({ endpointIds: ["a1"], apiKey: "k", graphqlUrl: "https://example.org/graphql" })).toMatchObject({ graphqlUrl: "https://example.org/graphql" });
  });
  it("needs an endpoint", () => {
    expect(() => parse({ apiKey: "k" })).toThrow(/needs at least one endpoint/);
  });
});

describe("parseStatusConfig", () => {
  it("fills the defaults", () => {
    const config = parseStatusConfig(JSON.stringify(base));
    expect(config.listen).toEqual({ host: "127.0.0.1", port: 8790 });
    expect(config.intervalSeconds).toBe(60);
    expect(config.retentionDays).toBe(30);
    expect(config.services.indexerLocal).toBe("http://127.0.0.1:42069");
    expect(config.units.map((unit) => unit.name)).not.toContain("zk-bridge-keepalive.timer");
    expect(config.units.find((unit) => unit.name === "zk-bridge-traffic")?.optional).toBe(true);
    expect(config.lightClients).toEqual({ keepAliveSeconds: 43200, marginSeconds: 21600, deadlineDegradedSeconds: 43200, deadlineDownSeconds: 21600 })
    expect(config.alerts).toBeUndefined();
  });

  it("drops the retired keep-alive timer from a file that still lists it", () => {
    const config = parseStatusConfig(JSON.stringify({ ...base, units: [{ name: "zk-bridge-backend" }, { name: "zk-bridge-keepalive.timer" }, { name: "zk-bridge-keepalive.service", optional: true }] }));
    expect(config.units.map((unit) => unit.name)).toEqual(["zk-bridge-backend"]);
  });

  it("refuses a file that is not JSON, has an unknown key or breaks a rule", () => {
    expect(() => parseStatusConfig("{")).toThrow(StatusConfigError);
    expect(() => parseStatusConfig(JSON.stringify({ ...base, extra: 1 }))).toThrow(/extra/);
    expect(() => parseStatusConfig(JSON.stringify({ ...base, wallets: [{ name: "x", address: "nope", low: {} }] }))).toThrow(StatusConfigError);
    expect(() => parseStatusConfig(JSON.stringify({ ...base, intervalSeconds: 1 }))).toThrow(StatusConfigError);
  });
});

describe("resolveReference", () => {
  it("reads env: references and passes literals through", () => {
    expect(resolveReference("env:RPC_A", environment)).toBe(environment.RPC_A);
    expect(resolveReference("https://x.example", environment)).toBe("https://x.example");
    expect(() => resolveReference("env:MISSING", environment)).toThrow(/MISSING/);
    expect(() => resolveReference("env:EMPTY", { EMPTY: "" })).toThrow(/EMPTY/);
  });
});

describe("loadStatusPair and secretValues", () => {
  const config = parseStatusConfig(JSON.stringify(base));

  it("builds the pair from the deployment file and the chain endpoints", () => {
    const pair = loadStatusPair(config, deployment, environment);
    expect(pair.sides[0].rpcUrl).toBe(environment.RPC_A);
    expect(pair.sides[0].beaconUrl).toBe(environment.BEACON_A);
    expect(pair.sides[1].beaconUrl).toBe("https://beacon.example.org");
    expect(pair.sides[0].contracts.gate).toBe("0x" + "5".repeat(40));
  });

  it("lets a chain go without a beacon endpoint", () => {
    const without = parseStatusConfig(JSON.stringify({ ...base, chains: { ...base.chains, "943": { label: "P", symbol: "tPLS", rpcUrl: "https://r.example" } } }));
    expect(loadStatusPair(without, deployment, environment).sides[1].beaconUrl).toBeNull();
  });

  it("refuses a pair whose chain has no entry in chains", () => {
    const missing = parseStatusConfig(JSON.stringify({ ...base, chains: { "943": base.chains["943"] } }));
    expect(() => loadStatusPair(missing, deployment, environment)).toThrow(/11155111/);
  });

  it("lists every secret value: endpoints and the RunPod key", () => {
    const values = secretValues(config, environment);
    expect(values).toEqual(expect.arrayContaining([environment.RPC_A, environment.BEACON_A, "rp_secret_value", "https://rpc.example.org/key"]));
    expect(secretValues(parseStatusConfig(JSON.stringify({ ...base, runpod: undefined })), environment)).not.toContain("rp_secret_value");
  });

  it("adds the alert webhook URL, from a reference or a literal, to the secrets", () => {
    const alerting = parseStatusConfig(JSON.stringify({ ...base, alerts: { webhookUrl: "env:HOOK", checks: ["rpc-943"] } }));
    expect(alerting.alerts).toEqual({ webhookUrl: "env:HOOK", checks: ["rpc-943"] });
    expect(secretValues(alerting, { ...environment, HOOK: "https://hooks.example.org/T0/secret" })).toContain("https://hooks.example.org/T0/secret");
    expect(secretValues(parseStatusConfig(JSON.stringify({ ...base, alerts: { webhookUrl: "https://hooks.example.org/lit" } })), environment)).toContain("https://hooks.example.org/lit");
    expect(() => secretValues(alerting, environment)).toThrow(/HOOK/);
  });
});
