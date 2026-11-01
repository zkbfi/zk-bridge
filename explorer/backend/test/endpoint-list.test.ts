import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CommandSpec } from "@zk-bridge/shared/prover";
import { endpointSecrets, endpointValues, readSecrets, remoteEndpoints, warmupTarget } from "../src/config.ts";
import { createProverFactories } from "../src/requests/job-prover.ts";
import { createProverPing } from "../src/watch/ping.ts";
import { PAIR, READ_SECRETS, SECRETS, makeConfig, memoryLogger } from "./support.ts";

const DEDICATED = { label: "dedicated", url: "http://203.0.113.7:40123", readyWaitSeconds: 20, timeoutSeconds: 120, attempts: 2 };
const SERVERLESS = { label: "serverless", url: "https://abc123.api.runpod.ai", apiKeyVariable: "RUNPOD_API_KEY" };
const BEARER = "bearer-value-0123456789-abcdefghijklmnop-5678";

/** A configuration with the endpoint list and no `runpodApiKeyVariable`. */
function listConfig(endpoints: readonly object[] = [DEDICATED, SERVERLESS]) {
  return makeConfig({ remote: { endpoints }, runpodApiKeyVariable: undefined });
}

describe("the endpoint list in the configuration", () => {
  it("loads a list in order without runpodApiKeyVariable", () => {
    const config = listConfig();
    expect(remoteEndpoints(config)).toEqual([DEDICATED, SERVERLESS]);
    expect(config.runpodApiKeyVariable).toBeUndefined();
  });

  it("still loads the single endpoint as a list of one, labelled remote, with the key of runpodApiKeyVariable", () => {
    expect(remoteEndpoints(makeConfig())).toEqual([{ label: "remote", url: "https://endpoint.example.org", apiKeyVariable: "RUNPOD_API_KEY" }]);
  });

  it.each([
    ["both forms", { remote: { endpoint: "https://e.example.org", endpoints: [SERVERLESS] } }, "not both and not neither"],
    ["neither form", { remote: {} }, "not both and not neither"],
    ["a single endpoint without its key variable", { runpodApiKeyVariable: undefined }, "remote.endpoint needs runpodApiKeyVariable"],
    ["a key sent over plain http", { remote: { endpoints: [{ ...SERVERLESS, url: "http://abc123.api.runpod.ai" }] } }, "must use https"],
    ["a label used twice", { remote: { endpoints: [DEDICATED, { ...SERVERLESS, label: "dedicated" }] } }, "its own label"],
    ["an empty list", { remote: { endpoints: [] } }, "remote.endpoints"],
    ["an unknown key in an entry", { remote: { endpoints: [{ ...DEDICATED, weight: 1 }] } }, "remote.endpoints.0"],
  ])("refuses %s", (_name, overrides, message) => {
    expect(() => makeConfig(overrides)).toThrow(message);
  });

  it("the example file uses the list: a dedicated worker first, the serverless endpoint as the fallback", () => {
    const config = makeConfig(JSON.parse(readFileSync(new URL("../backend.config.example.json", import.meta.url), "utf8")) as Record<string, unknown>);
    expect(remoteEndpoints(config).map((endpoint) => endpoint.label)).toEqual(["dedicated", "serverless"]);
    expect(remoteEndpoints(config)[0]?.apiKeyVariable).toBeUndefined();
  });
});

describe("the secrets of an endpoint list", () => {
  it("reads each key variable once and none for an endpoint without a key", () => {
    const backup = { label: "backup", url: "https://backup.example.org", apiKeyVariable: "BACKUP_KEY" };
    const config = listConfig([DEDICATED, SERVERLESS, backup, { ...SERVERLESS, label: "again" }]);
    const environment = { RUNPOD_API_KEY: SECRETS.runpodApiKey, BACKUP_KEY: "backup-secret-value", BACKEND_WEBHOOK_BEARER: BEARER };
    expect(readSecrets(config, environment)).toEqual({
      proverKeys: [
        { variable: "RUNPOD_API_KEY", value: SECRETS.runpodApiKey },
        { variable: "BACKUP_KEY", value: "backup-secret-value" },
      ],
      webhookBearer: BEARER,
    });
    expect(() => readSecrets(config, { ...environment, BACKUP_KEY: "" })).toThrow("set the environment variable BACKUP_KEY");
    expect(readSecrets(listConfig([DEDICATED]), { BACKEND_WEBHOOK_BEARER: BEARER }).proverKeys).toEqual([]);
  });

  it("hides every endpoint address, the address of a dedicated worker too", () => {
    const config = listConfig();
    expect(endpointValues(config, null)).toEqual(expect.arrayContaining([DEDICATED.url, SERVERLESS.url]));
    const secrets = endpointSecrets(config, null);
    expect(secrets).toEqual(expect.arrayContaining([DEDICATED.url, SERVERLESS.url]));
  });

  it("warms up the first endpoint only: with its key, or with none for a worker without a key", () => {
    expect(warmupTarget(listConfig(), { proverKeys: READ_SECRETS.proverKeys, webhookBearer: BEARER })).toEqual({ endpoint: DEDICATED.url, apiKey: null });
    expect(warmupTarget(listConfig([SERVERLESS, DEDICATED]), READ_SECRETS)).toEqual({ endpoint: SERVERLESS.url, apiKey: SECRETS.runpodApiKey });
    expect(warmupTarget(makeConfig(), READ_SECRETS)).toEqual({ endpoint: "https://endpoint.example.org", apiKey: SECRETS.runpodApiKey });
  });

  it("pings a worker without a key with no authorization header", async () => {
    const seen: Array<string | null> = [];
    const fetchFunction = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    expect(await createProverPing({ endpoint: DEDICATED.url, apiKey: null, fetchFunction: () => fetchFunction })()).toBe(200);
    expect(seen).toEqual([null]);
  });
});

describe("a proving job with an endpoint list", () => {
  it("writes the list into the prover file and gives the child each key, never writing a key into the file", async () => {
    const runs: Array<{ spec: CommandSpec; file: string }> = [];
    const executor = async (spec: CommandSpec) => {
      runs.push({ spec, file: readFileSync(spec.args[1] as string, "utf8") });
      return { code: 3, stdout: "", stderr: "" };
    };
    const factories = createProverFactories({ config: listConfig(), pair: PAIR, executor, secrets: READ_SECRETS, path: "/usr/bin", logger: memoryLogger().logger });
    await expect(factories.proverForJob("job-1").prove({ direction: "first-to-second" })).resolves.toEqual({ kind: "up-to-date" });
    const { spec, file } = runs[0]!;
    expect(file).toContain('[[prover.remote_endpoints]]\nlabel = "dedicated"\nurl = "http://203.0.113.7:40123"\nready_wait_seconds = 20');
    expect(file).toContain('label = "serverless"\nurl = "https://abc123.api.runpod.ai"\napi_key_env = "RUNPOD_API_KEY"');
    expect(file).not.toContain("remote_url");
    expect(file).not.toContain(SECRETS.runpodApiKey);
    expect(spec.environment.RUNPOD_API_KEY).toBe(SECRETS.runpodApiKey);
    expect(spec.environment.BACKEND_WEBHOOK_BEARER).toBe(SECRETS.webhookBearer);
  });
});
