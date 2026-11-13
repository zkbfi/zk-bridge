import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadPair, type Pair } from "../src/index.js";
import type { CommandExecutor } from "../src/prover/execute-command.js";
import { createProverBinary } from "../src/prover/prover-binary.js";
import { describeRoute, renderProverConfig, type BackendSection } from "../src/prover/prover-config.js";
import { DEFAULT_READY_WAIT_SECONDS, MAX_REMOTE_ENDPOINTS, SINGLE_ENDPOINT_LABEL, endpointKeyVariables, remoteEndpointListSchema, remoteEndpointSchema } from "../src/prover/remote-endpoints.js";
import { memoryLogger } from "./support/prover-builders.js";

function section(chainId: number, seed: number) {
  const address = (offset: number) => `0x${(seed + offset).toString(16).padStart(2, "0").repeat(20)}`;
  return { chain_id: chainId, bridge: address(1), mediator: address(2), token_factory: address(3), wrapped_native: address(5), gate: address(6), light_client: address(7), start_block: 5 };
}
const pair: Pair = loadPair({
  environment: {
    EXPLORER_RPC_URL_1: "http://127.0.0.1:1",
    EXPLORER_RPC_URL_369: "http://127.0.0.1:2",
    EXPLORER_BEACON_URL_1: "http://127.0.0.1:3",
    EXPLORER_BEACON_URL_369: "http://127.0.0.1:4",
  },
  deployment: { chain_a: section(1, 0x10), chain_b: section(369, 0x20) },
});

const dedicated = { label: "dedicated", url: "http://203.0.113.7:40123", readyWaitSeconds: 20, timeoutSeconds: 120, attempts: 2 };
const serverless = { label: "serverless", url: "https://abc123.api.runpod.ai", apiKeyVariable: "RUNPOD_API_KEY" };
const listBackend: BackendSection = { kind: "remote", mode: { mode: "load-balancing" }, endpoints: [dedicated, serverless] };

describe("the endpoint list schema", () => {
  it("accepts a dedicated worker without a key on plain http and a serverless endpoint with a key on https", () => {
    expect(remoteEndpointListSchema.parse([dedicated, serverless])).toEqual([dedicated, serverless]);
    expect(remoteEndpointSchema.parse({ label: "local", url: "http://127.0.0.1:8000", apiKeyVariable: "K" }).url).toBe("http://127.0.0.1:8000");
    expect(remoteEndpointSchema.parse({ label: "zero-wait", url: "https://x.example.org", readyWaitSeconds: 0 }).readyWaitSeconds).toBe(0);
  });

  it("accepts a start wait below the ready wait of the endpoint, or below the default ready wait without one", () => {
    expect(remoteEndpointSchema.parse({ ...serverless, startWaitSeconds: 30, readyWaitSeconds: 600 }).startWaitSeconds).toBe(30);
    expect(remoteEndpointSchema.parse({ ...serverless, startWaitSeconds: DEFAULT_READY_WAIT_SECONDS - 1 }).startWaitSeconds).toBe(899);
  });

  it.each([
    ["a key over plain http to another machine", { ...serverless, url: "http://abc123.api.runpod.ai" }, "must use https"],
    ["a label in capitals", { ...dedicated, label: "Dedicated" }, "lower case"],
    ["an empty label", { ...dedicated, label: "" }, "lower case"],
    ["a label that is too long", { ...dedicated, label: "x".repeat(33) }, "lower case"],
    ["a secret where a variable name belongs", { ...serverless, apiKeyVariable: "rpa_0123456789" }, "NAME of an environment variable"],
    ["an address that is not http", { ...dedicated, url: "ftp://203.0.113.7" }, ""],
    ["zero attempts", { ...dedicated, attempts: 0 }, ""],
    ["a zero timeout", { ...dedicated, timeoutSeconds: 0 }, ""],
    ["a negative wait", { ...dedicated, readyWaitSeconds: -1 }, ""],
    ["an unknown key", { ...dedicated, weight: 2 }, ""],
    ["a zero start wait", { ...serverless, startWaitSeconds: 0 }, ""],
    ["a start wait that is not whole", { ...serverless, startWaitSeconds: 1.5 }, ""],
    ["a start wait at the ready wait", { ...dedicated, startWaitSeconds: 20 }, "must be below the ready wait"],
    ["a start wait at the default ready wait", { ...serverless, startWaitSeconds: DEFAULT_READY_WAIT_SECONDS }, "must be below the ready wait"],
  ])("refuses %s", (_name, entry, message) => {
    const result = remoteEndpointSchema.safeParse(entry);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(" ")).toContain(message);
  });

  it("refuses an empty list, a list that is too long, and a label used twice", () => {
    expect(remoteEndpointListSchema.safeParse([]).success).toBe(false);
    const many = Array.from({ length: MAX_REMOTE_ENDPOINTS + 1 }, (_, index) => ({ label: `e${index}`, url: "https://e.example.org" }));
    expect(remoteEndpointListSchema.safeParse(many).success).toBe(false);
    const twice = remoteEndpointListSchema.safeParse([dedicated, { ...serverless, label: "dedicated" }]);
    expect(twice.error?.issues[0]?.message).toBe("every endpoint needs its own label");
  });

  it("lists each key variable once, in list order, and none for an endpoint without a key", () => {
    expect(endpointKeyVariables([dedicated, serverless, { ...serverless, label: "second" }, { label: "other", url: "https://o.example.org", apiKeyVariable: "OTHER_KEY" }])).toEqual(["RUNPOD_API_KEY", "OTHER_KEY"]);
    expect(endpointKeyVariables([dedicated])).toEqual([]);
    expect(SINGLE_ENDPOINT_LABEL).toBe("remote");
  });
});

describe("the prover configuration with an endpoint list", () => {
  const route = describeRoute(pair, "first-to-second");

  it("writes one [[prover.remote_endpoints]] table per endpoint, in order, inside the [prover] section", () => {
    const text = renderProverConfig(route, listBackend, { webhookUrl: "https://backend.example.org/webhook/jobs/1", bearerVariable: "BEARER" });
    const prover = text.slice(text.indexOf("[prover]"), text.indexOf("[handoff]"));
    expect(prover).toBe(
      [
        "[prover]",
        'backend = "remote"',
        "remote_timeout_seconds = 360",
        "remote_attempts = 3",
        "",
        "[[prover.remote_endpoints]]",
        'label = "dedicated"',
        'url = "http://203.0.113.7:40123"',
        "ready_wait_seconds = 20",
        "timeout_seconds = 120",
        "attempts = 2",
        "",
        "[[prover.remote_endpoints]]",
        'label = "serverless"',
        'url = "https://abc123.api.runpod.ai"',
        'api_key_env = "RUNPOD_API_KEY"',
        "",
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("remote_url");
    expect(text).toContain('targets = ["stdout", "webhook"]');
  });

  it("writes the start wait of a GPU tier as start_wait_seconds", () => {
    const tiers: BackendSection = {
      kind: "remote",
      mode: { mode: "load-balancing" },
      endpoints: [
        { label: "gpu-24gb", url: "https://a.api.runpod.ai", apiKeyVariable: "RUNPOD_API_KEY", startWaitSeconds: 30 },
        { label: "gpu-48gb", url: "https://c.api.runpod.ai", apiKeyVariable: "RUNPOD_API_KEY" },
      ],
    };
    const text = renderProverConfig(route, tiers);
    expect(text).toContain('[[prover.remote_endpoints]]\nlabel = "gpu-24gb"\nurl = "https://a.api.runpod.ai"\napi_key_env = "RUNPOD_API_KEY"\nstart_wait_seconds = 30\n');
    expect(text.match(/start_wait_seconds/g)).toHaveLength(1);
  });

  it("refuses a value that the file cannot carry", () => {
    const quote: BackendSection = { kind: "remote", mode: { mode: "load-balancing" }, endpoints: [{ label: 'a"b', url: "https://x.example.org" }] };
    expect(() => renderProverConfig(route, quote)).toThrow("remote endpoint label holds a character");
    for (const bad of [{ attempts: 1.5 }, { timeoutSeconds: -1 }, { readyWaitSeconds: Number.NaN }, { startWaitSeconds: -3 }]) {
      const backend: BackendSection = { kind: "remote", mode: { mode: "load-balancing" }, endpoints: [{ label: "x", url: "https://x.example.org", ...bad }] };
      expect(() => renderProverConfig(route, backend)).toThrow("must be a whole number");
    }
  });
});

describe("the prover wrapper with an endpoint list", () => {
  const scratch: string[] = [];
  afterAll(async () => {
    for (const directory of scratch) await rm(directory, { recursive: true, force: true });
  });

  it("gives the child every key under the variable that the file names, and writes the list into the file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "endpoint-list-"));
    scratch.push(directory);
    let environment: Readonly<Record<string, string>> = {};
    let configText = "";
    const executor: CommandExecutor = async (spec) => {
      environment = spec.environment;
      configText = await readFile(spec.args[1] as string, "utf8");
      return { code: 3, stdout: "", stderr: "" };
    };
    const binary = createProverBinary({
      binaryPath: "/bin/zk-bridge-prover",
      pair,
      executor,
      timeoutMilliseconds: 1000,
      backend: { kind: "remote", mode: { mode: "load-balancing" }, endpoints: [dedicated, serverless, { label: "backup", url: "https://backup.example.org", apiKeyVariable: "BACKUP_KEY" }] },
      proverSecret: [
        { variable: "RUNPOD_API_KEY", value: "rpa_TESTONLY_one" },
        { variable: "BACKUP_KEY", value: "backup_TESTONLY_two" },
      ],
      baseEnvironment: { PATH: "/usr/bin" },
      temporaryDirectory: directory,
      logger: memoryLogger().logger,
    });
    await expect(binary.prove({ direction: "first-to-second" })).resolves.toEqual({ kind: "up-to-date" });
    expect(environment).toEqual({ PATH: "/usr/bin", RUNPOD_API_KEY: "rpa_TESTONLY_one", BACKUP_KEY: "backup_TESTONLY_two" });
    expect(configText).toContain('label = "backup"');
    expect(configText).not.toContain("TESTONLY");
  });
});
