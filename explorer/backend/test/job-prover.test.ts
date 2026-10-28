import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CommandExecutor, CommandSpec } from "@zk-bridge/shared/prover";
import { createProverFactories } from "../src/requests/job-prover.ts";
import { DEFAULT_RATE_LIMITS } from "../src/requests/rate-limit.ts";
import { createRequestService } from "../src/requests/service.ts";
import { openStorage } from "../src/storage.ts";
import { PAIR, SECRETS, makeClock, makeConfig, memoryLogger } from "./support.ts";

function recordingExecutor() {
  const runs: Array<{ spec: CommandSpec; file: string }> = [];
  const executor: CommandExecutor = async (spec) => {
    const configPath = spec.args[spec.args.indexOf("--config") + 1] as string;
    runs.push({ spec, file: await readFile(configPath, "utf8") });
    return { code: 3, stdout: "", stderr: "" };
  };
  return { executor, runs };
}

describe("the prover of a job", () => {
  it("the job runs prove with a webhook to /webhook/jobs/<id> and the bearer variable name only", async () => {
    const { executor, runs } = recordingExecutor();
    const log = memoryLogger();
    const factories = createProverFactories({ config: makeConfig(), pair: PAIR, executor, secrets: SECRETS, path: "/usr/bin", logger: log.logger });
    const service = createRequestService({
      storage: openStorage(":memory:"),
      proverForJob: factories.proverForJob,
      now: makeClock().now,
      limits: DEFAULT_RATE_LIMITS,
      proverTimeoutMilliseconds: 1_800_000,
      logger: log.logger,
    });
    const answer = service.submit({ pair: "eth-pls", direction: "first-to-second", reason: "user", caller: "a" });
    if ("refused" in answer) throw new Error("refused");
    await service.settled();

    expect(runs).toHaveLength(1);
    const { spec, file } = runs[0]!;
    expect(file).toContain(`webhook_url = "https://backend.example.org/webhook/jobs/${answer.jobId}"`);
    expect(file).toContain('webhook_bearer_env = "BACKEND_WEBHOOK_BEARER"');
    expect(file).toContain('backend = "remote"');
    expect(file).toContain('remote_api_key_env = "RUNPOD_API_KEY"');
    // The file and the arguments hold names, never a value.
    for (const value of Object.values(SECRETS)) {
      expect(file).not.toContain(value);
      expect(spec.args.join(" ")).not.toContain(value);
    }
    // The values reach the child only through its environment.
    expect(spec.environment.BACKEND_WEBHOOK_BEARER).toBe(SECRETS.webhookBearer);
    expect(spec.environment.RUNPOD_API_KEY).toBe(SECRETS.runpodApiKey);
    // The prover starts from the head on chain: no head argument.
    expect(spec.args.join(" ")).not.toMatch(/--(head|start|slot)/);
  });

  it("the utility prover has no proving backend", async () => {
    const { executor } = recordingExecutor();
    const factories = createProverFactories({ config: makeConfig(), pair: PAIR, executor, secrets: SECRETS, path: "/usr/bin", logger: memoryLogger().logger });
    await expect(factories.utilityProver.prove({ direction: "first-to-second" })).rejects.toThrow(/no proving backend/);
  });
});
