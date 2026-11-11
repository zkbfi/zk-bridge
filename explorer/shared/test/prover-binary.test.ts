import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPair, type Pair } from "../src/index.js";
import type { CommandExecutor, CommandSpec } from "../src/prover/execute-command.js";
import { EXIT_UP_TO_DATE, ProverCommandError, ProverOutputError, createProverBinary, parseHandoffRecord } from "../src/prover/prover-binary.js";
import { describeRoute, renderProverConfig } from "../src/prover/prover-config.js";
import { evidenceFor, memoryLogger, word } from "./support/prover-builders.js";
import { forkProofRecordFixture } from "./support/fork-proof-fixture.js";

function section(chainId: number, seed: number) {
  const make = (offset: number) => `0x${(seed + offset).toString(16).padStart(2, "0").repeat(20)}`;
  return { chain_id: chainId, bridge: make(1), mediator: make(2), token_factory: make(3), wrapped_native: make(5), gate: make(6), light_client: make(7), start_block: 5 };
}
const environment = {
  EXPLORER_RPC_URL_1: "http://127.0.0.1:1",
  EXPLORER_RPC_URL_369: "http://127.0.0.1:2",
  EXPLORER_BEACON_URL_1: "http://127.0.0.1:3",
  EXPLORER_BEACON_URL_369: "http://127.0.0.1:4",
};
const pair: Pair = loadPair({ environment, deployment: { chain_a: section(1, 0x10), chain_b: section(369, 0x20) } });
const remote = { kind: "remote", mode: { mode: "load-balancing" }, endpoint: "https://worker.example.org", apiKeyVariable: "RUNPOD_API_KEY" } as const;

const proofPackage = {
  schemaVersion: 1,
  route: "ethereum_to_pulsechain",
  programKey: word(0x42),
  startHeadSlot: 100,
  startHeadRoot: word(1),
  newHeadSlot: 164,
  newHeadRoot: word(2),
  latestFinalizedSlot: 200,
  publicValues: "0x01",
  proof: "0x02",
  updateCalldata: "0x03",
  backend: "remote",
  createdAt: "2026-10-25T00:00:00Z",
};

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface Seen {
  readonly spec: CommandSpec;
  readonly configText: string | null;
  readonly configMode: number | null;
  readonly configPath: string | null;
}

async function setup(answer: { code: number; stdout?: string; stderr?: string }, extra: { backend?: typeof remote | null; secret?: boolean; defaultDirectory?: boolean; handoff?: { webhookUrl: string; bearerVariable: string }; stateCacheDirectory?: string; proofCacheDirectory?: string; handoffArchiveUrls?: readonly string[]; forkProofArchiveUrls?: readonly string[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "prover-binary-"));
  scratch.push(directory);
  const seen: Seen[] = [];
  const executor: CommandExecutor = async (spec) => {
    const configPath = spec.args[1] === undefined || !spec.args[0]?.startsWith("--config") ? null : spec.args[1];
    seen.push({
      spec,
      configPath,
      configText: configPath === null ? null : readFileSync(configPath, "utf8"),
      configMode: configPath === null ? null : statSync(configPath).mode & 0o777,
    });
    return { code: answer.code, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  };
  const { logger, events } = memoryLogger();
  const binary = createProverBinary({
    binaryPath: "/bin/zk-bridge-prover",
    pair,
    executor,
    timeoutMilliseconds: 777,
    backend: extra.backend === undefined ? remote : extra.backend,
    proverSecret: extra.secret === true ? { variable: "RUNPOD_API_KEY", value: "rpa_TESTONLY1234567890abcdefghijkl" } : null,
    baseEnvironment: { PATH: "/usr/bin" },
    ...(extra.handoff === undefined ? {} : { handoff: extra.handoff }),
    ...(extra.defaultDirectory === true ? {} : { temporaryDirectory: join(directory, "nested") }),
    ...(extra.stateCacheDirectory === undefined ? {} : { stateCacheDirectory: extra.stateCacheDirectory }),
    ...(extra.proofCacheDirectory === undefined ? {} : { proofCacheDirectory: extra.proofCacheDirectory }),
    ...(extra.handoffArchiveUrls === undefined ? {} : { handoffArchiveUrls: extra.handoffArchiveUrls }),
    ...(extra.forkProofArchiveUrls === undefined ? {} : { forkProofArchiveUrls: extra.forkProofArchiveUrls }),
    logger,
  });
  return { binary, seen, directory, events };
}

describe("prove", () => {
  it("runs the binary with the route and the file, and returns the proof package", async () => {
    const { binary, seen, directory } = await setup({ code: 0, stdout: `${JSON.stringify(proofPackage)}\n` }, { secret: true });
    expect(await binary.prove({ direction: "first-to-second" })).toEqual({ kind: "proof", proofPackage, timing: null });
    const { spec, configText, configMode, configPath } = seen[0]!;
    expect(spec.command).toBe("/bin/zk-bridge-prover");
    expect(spec.args).toEqual(["--config", configPath, "prove", "--route", "ethereum_to_pulsechain", "--to", "stdout"]);
    expect(spec.timeoutMilliseconds).toBe(777);
    expect(configText).toBe(renderProverConfig(describeRoute(pair, "first-to-second"), remote));
    expect(configMode).toBe(0o600);
    expect(spec.environment).toEqual({ PATH: "/usr/bin", RUNPOD_API_KEY: "rpa_TESTONLY1234567890abcdefghijkl" });
    expect(spec.args.join(" ")).not.toContain("rpa_TESTONLY");
    expect(configText).not.toContain("rpa_TESTONLY");
    expect(existsSync(configPath!)).toBe(false);
    expect(await readdir(join(directory, "nested"))).toEqual([]);
  });

  it("logs job_proved with the step timings that the prover wrote on standard error", async () => {
    const stderr = [
      "ts=1 level=info event=prove_started route=ethereum_to_pulsechain backend=remote",
      "ts=2 level=info event=prove_step step=build elapsed_ms=1200",
      'ts=9 level=info event=prove_timing build_ms=1200 native_ms=610 wait_worker_ms=60000 not_ready_count=2 retry_count=0 remote_ms=43000 verify_ms=10 prove_ms=100000 total_ms=101700 worker_timings=reported worker_prove_ms=41000 worker_total_ms=42000 remote_overhead_ms=1000 worker_gpu="NVIDIA L40S" worker_cpu_count=32',
      "ts=10 level=info event=proof_handed_off new_head_slot=164",
    ].join("\n");
    const { binary, events } = await setup({ code: 0, stdout: JSON.stringify(proofPackage), stderr });
    const outcome = await binary.prove({ direction: "first-to-second" });
    // The timing comes back with the proof too: the backend's warm-up learns the cold start from it.
    expect(outcome).toMatchObject({ kind: "proof", timing: { wait_worker_ms: 60000, not_ready_count: 2 } });
    const logged = events().find((event) => event.event === "job_proved");
    expect(logged).toEqual({
      level: "info",
      event: "job_proved",
      route: "ethereum_to_pulsechain",
      newHeadSlot: 164,
      timingReported: true,
      build_ms: 1200,
      native_ms: 610,
      wait_worker_ms: 60000,
      not_ready_count: 2,
      retry_count: 0,
      remote_ms: 43000,
      verify_ms: 10,
      prove_ms: 100000,
      total_ms: 101700,
      worker_timings: "reported",
      worker_prove_ms: 41000,
      worker_total_ms: 42000,
      remote_overhead_ms: 1000,
      worker_gpu: "NVIDIA L40S",
      worker_cpu_count: 32,
    });
  });

  it("logs job_proved without timings when the prover wrote none", async () => {
    const { binary, events } = await setup({ code: 0, stdout: JSON.stringify(proofPackage), stderr: "ts=1 level=info event=prove_started" });
    await binary.prove({ direction: "first-to-second" });
    expect(events().find((event) => event.event === "job_proved")).toEqual({
      level: "info",
      event: "job_proved",
      route: "ethereum_to_pulsechain",
      newHeadSlot: 164,
      timingReported: false,
    });
  });

  it("logs no job_proved when the run fails or has nothing to prove", async () => {
    const failed = await setup({ code: 1, stderr: "ts=1 level=error event=boom" });
    await expect(failed.binary.prove({ direction: "first-to-second" })).rejects.toBeInstanceOf(ProverCommandError);
    const upToDate = await setup({ code: EXIT_UP_TO_DATE });
    await upToDate.binary.prove({ direction: "first-to-second" });
    expect([...failed.events(), ...upToDate.events()].some((event) => event.event === "job_proved")).toBe(false);
  });

  it("names the state cache directory in the file when the caller keeps one", async () => {
    const { binary, seen } = await setup({ code: 0, stdout: JSON.stringify(proofPackage) }, { stateCacheDirectory: "/var/lib/bot/beacon-states" });
    await binary.prove({ direction: "first-to-second" });
    expect(seen[0]!.configText).toContain('state_cache_dir = "/var/lib/bot/beacon-states"');
  });

  it("names the proof cache directory in the file of opening-proof when the caller keeps one", async () => {
    const opening = { schemaVersion: 1 };
    const { binary, seen } = await setup({ code: 1, stderr: "boom", stdout: JSON.stringify(opening) }, { backend: null, proofCacheDirectory: "/var/lib/bot/proof-cache" });
    await expect(binary.openingProof({ direction: "second-to-first" })).rejects.toThrow();
    expect(seen[0]!.configText).toContain('proof_cache_dir = "/var/lib/bot/proof-cache"');
    expect(seen[0]!.configText).not.toContain("state_cache_dir");
  });

  it("keeps the secret out of the child environment when none is given", async () => {
    const { binary, seen } = await setup({ code: 0, stdout: JSON.stringify(proofPackage) });
    await binary.prove({ direction: "second-to-first" });
    expect(seen[0]!.spec.environment).toEqual({ PATH: "/usr/bin" });
    expect(seen[0]!.spec.args).toContain("pulsechain_to_ethereum");
  });

  it("reports up to date for exit code 3, and removes the file", async () => {
    expect(EXIT_UP_TO_DATE).toBe(3);
    const { binary, seen } = await setup({ code: 3 });
    expect(await binary.prove({ direction: "first-to-second" })).toEqual({ kind: "up-to-date" });
    expect(existsSync(seen[0]!.configPath!)).toBe(false);
  });

  it("throws the command error with the code and the tail of standard error for another failure", async () => {
    const { binary } = await setup({ code: 2, stderr: `  ${"x".repeat(2000)}end\n` });
    const failure = await binary.prove({ direction: "first-to-second" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProverCommandError);
    expect(failure).toMatchObject({ command: "prove", exitCode: 2 });
    const detail = (failure as ProverCommandError).detail;
    expect(detail).toHaveLength(1500);
    expect(detail.endsWith("xxxend")).toBe(true);
    expect((failure as Error).message).toBe(`zk-bridge-prover prove exited with code 2: ${detail}`);
  });

  it("keeps a short standard error whole, without its surrounding blanks", async () => {
    const { binary } = await setup({ code: 1, stderr: "\n  cannot reach the worker \n" });
    await expect(binary.prove({ direction: "first-to-second" })).rejects.toThrow("zk-bridge-prover prove exited with code 1: cannot reach the worker");
  });

  it("refuses to run without a proving backend, before it writes a file", async () => {
    const { binary, seen, directory } = await setup({ code: 0 }, { backend: null });
    await expect(binary.prove({ direction: "first-to-second" })).rejects.toThrow("this prover wrapper has no proving backend");
    expect(seen).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    ["no output", "", "prove printed 0 lines on standard output, expected one"],
    ["two lines", "{}\n{}\n", "prove printed 2 lines on standard output, expected one"],
    ["text that is not JSON", "not json\n", "prove printed a line that is not JSON"],
  ])("rejects %s", async (_name, stdout, message) => {
    const { binary } = await setup({ code: 0, stdout });
    const failure = await binary.prove({ direction: "first-to-second" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProverOutputError);
    expect((failure as Error).message).toBe(message);
  });

  it("names every broken field of a package of the wrong shape, and removes the file", async () => {
    const { binary, seen } = await setup({ code: 0, stdout: JSON.stringify({ ...proofPackage, schemaVersion: 2, proof: "nothex" }) });
    const failure = await binary.prove({ direction: "first-to-second" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProverOutputError);
    expect((failure as Error).message).toMatch(/^prove printed an unexpected package: Invalid input: expected 1; must be 0x hex$/);
    expect(existsSync(seen[0]!.configPath!)).toBe(false);
  });

  it("writes the file under the system temporary directory when no directory is given", async () => {
    const { binary, seen } = await setup({ code: 3 }, { defaultDirectory: true });
    await binary.prove({ direction: "first-to-second" });
    expect(seen[0]!.configPath!.startsWith(tmpdir())).toBe(true);
  });
});

describe("handoff-update", () => {
  const record = JSON.stringify({ attestedSlot: 8000, chainId: 1, finalizedSlot: 7900, format: "zkb-handoff-update/1", nextSyncCommitteeRoot: word(3), period: 0, signatureSlot: 8001, update: { signature_slot: "8001" } });

  it("runs handoff-update on the route with the period and the archive in the file, and gives the record line exactly", async () => {
    const { binary, seen } = await setup({ code: 0, stdout: `${record}\n` }, { backend: null, handoffArchiveUrls: ["http://127.0.0.1:8787/archive/handoffs"] });
    const answer = await binary.handoffUpdate({ direction: "first-to-second", period: 0 });
    expect(answer).toEqual({ text: record, chainId: 1, period: 0, attestedSlot: 8000, finalizedSlot: 7900, signatureSlot: 8001 });
    expect(seen[0]!.spec.args.slice(2)).toEqual(["handoff-update", "--route", "ethereum_to_pulsechain", "--period", "0"]);
    expect(seen[0]!.configText).toContain('handoff_archive_urls = ["http://127.0.0.1:8787/archive/handoffs"]');
    expect(seen[0]!.configText).not.toContain("[prover]");
  });

  it("throws the command error with the tail of standard error", async () => {
    const { binary } = await setup({ code: 1, stderr: "no source has the handoff update" }, { backend: null });
    await expect(binary.handoffUpdate({ direction: "second-to-first", period: 3 })).rejects.toThrow(/no source has the handoff update/);
  });

  it("refuses a line that is not a handoff record", () => {
    expect(() => parseHandoffRecord(JSON.stringify({ format: "other", update: {} }))).toThrow(ProverOutputError);
    expect(() => parseHandoffRecord(JSON.stringify({ format: "zkb-handoff-update/1", update: null }))).toThrow(ProverOutputError);
    expect(() => parseHandoffRecord("null")).toThrow(ProverOutputError);
    expect(() => parseHandoffRecord(JSON.stringify({ format: "zkb-handoff-update/1", update: {}, chainId: 1, period: -1, attestedSlot: 1, finalizedSlot: 1, signatureSlot: 1 }))).toThrow(/numbers/);
  });
});

describe("fork-proof", () => {
  const fixture = forkProofRecordFixture({ chainId: 369 });
  const transactionHash = word(9);

  it("runs fork-proof on the route with the transaction, and gives the checked record with its text exactly", async () => {
    const { binary, seen } = await setup({ code: 0, stdout: `${fixture.text}\n` }, { backend: null, forkProofArchiveUrls: ["http://127.0.0.1:8787/archive/fork-proofs"] });
    const answer = await binary.forkProof({ direction: "second-to-first", transactionHash, chainId: 369 });
    expect(answer).toMatchObject({ text: fixture.text, chainId: 369, stateRoot: fixture.stateRoot, slot: 5678, executionBlockNumber: 1234, shape: 6 });
    expect(seen[0]!.spec.args.slice(2)).toEqual(["fork-proof", "--route", "pulsechain_to_ethereum", "--tx", transactionHash]);
    expect(seen[0]!.configText).toContain('fork_proof_archive_urls = ["http://127.0.0.1:8787/archive/fork-proofs"]');
  });

  it("throws the command error with the tail of standard error", async () => {
    const { binary } = await setup({ code: 1, stderr: "the beacon block is not final yet" }, { backend: null });
    await expect(binary.forkProof({ direction: "second-to-first", transactionHash, chainId: 369 })).rejects.toThrow(/not final yet/);
  });

  it("refuses a record that fails the check, and output that is not one JSON line", async () => {
    const other = await setup({ code: 0, stdout: `${fixture.text}\n` }, { backend: null });
    await expect(other.binary.forkProof({ direction: "first-to-second", transactionHash, chainId: 1 })).rejects.toThrow(/fails the check: another chain/);
    const twoLines = await setup({ code: 0, stdout: `${fixture.text}\n${fixture.text}\n` }, { backend: null });
    await expect(twoLines.binary.forkProof({ direction: "second-to-first", transactionHash, chainId: 369 })).rejects.toThrow(ProverOutputError);
  });
});

describe("fork-observation", () => {
  const registry = "0x4444444444444444444444444444444444444444" as const;
  const observation = {
    schemaVersion: 1,
    route: "pulsechain_to_ethereum",
    chainId: 369,
    registry,
    lightClient: "0x5555555555555555555555555555555555555555",
    programKey: word(0x66),
    startHeadSlot: 100,
    observedVersion: "0x0000036a",
    shape: 5,
    observedAttestedSlot: 900,
    foldSteps: 3,
    publicValues: `0x${"00".repeat(256)}`,
    proof: "0x1234",
    observeCalldata: "0xabcd",
    backend: "remote",
    createdAt: "2026-11-11T00:00:00Z",
  };
  const timingLine = "ts=1 level=info event=prove_timing total_ms=1000 worker_total_ms=900";

  it("runs fork-observation on the route with the registry and the proving backend, and gives the package and the timing", async () => {
    const { binary, seen } = await setup({ code: 0, stdout: `${JSON.stringify(observation)}\n`, stderr: timingLine }, { secret: true });
    const answer = await binary.forkObservation({ direction: "second-to-first", registry });
    expect(answer.observation).toEqual(observation);
    expect(answer.timing).toMatchObject({ total_ms: 1000, worker_total_ms: 900 });
    expect(seen[0]!.spec.args.slice(2)).toEqual(["fork-observation", "--route", "pulsechain_to_ethereum", "--registry", registry]);
    expect(seen[0]!.configText).toContain('backend = "remote"');
    expect(seen[0]!.configText).not.toContain("webhook_url");
  });

  it("needs a proving backend, throws the command error, and refuses another output", async () => {
    const none = await setup({ code: 0 }, { backend: null });
    await expect(none.binary.forkObservation({ direction: "second-to-first", registry })).rejects.toThrow(/no proving backend/);
    const failed = await setup({ code: 1, stderr: "the observation program refuses every fold" });
    await expect(failed.binary.forkObservation({ direction: "second-to-first", registry })).rejects.toThrow(/refuses every fold/);
    const other = await setup({ code: 0, stdout: JSON.stringify({ ...observation, shape: "five" }) });
    await expect(other.binary.forkObservation({ direction: "second-to-first", registry })).rejects.toThrow(/unexpected package/);
    const quiet = await setup({ code: 0, stdout: JSON.stringify(observation) });
    expect((await quiet.binary.forkObservation({ direction: "second-to-first", registry })).timing).toBeNull();
  });
});

describe("evidence", () => {
  const evidence = evidenceFor();

  it("runs the binary with the route, the transaction and the log index, with no backend section", async () => {
    const { binary, seen } = await setup({ code: 0, stdout: JSON.stringify(evidence) });
    expect(await binary.evidence({ direction: "first-to-second", transactionHash: word(0xa1), logIndex: 4 })).toEqual(evidence);
    const { spec, configText, configPath } = seen[0]!;
    expect(spec.args).toEqual(["--config", configPath, "evidence", "--route", "ethereum_to_pulsechain", "--tx", word(0xa1), "--log-index", "4"]);
    expect(configText).toBe(renderProverConfig(describeRoute(pair, "first-to-second"), null));
  });

  it("throws the command error when the binary fails", async () => {
    const { binary } = await setup({ code: 5, stderr: "no such transaction" });
    await expect(binary.evidence({ direction: "first-to-second", transactionHash: word(1), logIndex: 0 })).rejects.toThrow("zk-bridge-prover evidence exited with code 5: no such transaction");
  });

  it("names every broken field of evidence of the wrong shape", async () => {
    const { binary } = await setup({ code: 0, stdout: JSON.stringify({ ...evidence, alreadyDelivered: "no", logIndex: -1 }) });
    const failure = await binary.evidence({ direction: "first-to-second", transactionHash: word(1), logIndex: 0 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProverOutputError);
    expect((failure as Error).message.startsWith("evidence printed an unexpected package: ")).toBe(true);
    expect((failure as Error).message).toContain("; ");
  });
});

describe("verify", () => {
  const request = { programKey: word(0x42), publicValues: "0x0102", proof: "0x0304" } as const;

  it("passes the three values as arguments to the verify command and needs no file", async () => {
    const { binary, seen, events } = await setup({ code: 0, stdout: JSON.stringify({ valid: true, programKey: word(0x42) }) });
    await expect(binary.verify(request)).resolves.toBeUndefined();
    expect(seen[0]!.spec.args).toEqual(["verify", "--program-vkey", word(0x42), "--public-values", "0x0102", "--proof", "0x0304"]);
    expect(seen[0]!.configPath).toBeNull();
    expect(events()[0]).toMatchObject({ level: "debug", event: "prover_command", command: "verify" });
  });

  it("throws the command error when the proof does not verify", async () => {
    const { binary } = await setup({ code: 1, stderr: "proof is invalid" });
    await expect(binary.verify(request)).rejects.toThrow("zk-bridge-prover verify exited with code 1: proof is invalid");
  });

  it.each([
    ["an answer that says the proof is not valid", { valid: false, programKey: word(0x42) }],
    ["an answer that lacks the program key", { valid: true }],
  ])("rejects %s, even though the exit code is 0", async (_name, body) => {
    const { binary } = await setup({ code: 0, stdout: JSON.stringify(body) });
    await expect(binary.verify(request)).rejects.toThrow(new ProverOutputError("verify printed an unexpected answer"));
  });
});

describe("the prover configuration of the sp1 backend and the webhook", () => {
  const route = describeRoute(pair, "first-to-second");

  it("renderProverConfig writes the sp1 backend with both program file paths", () => {
    const text = renderProverConfig(route, { kind: "sp1", lightClientElfPath: "/opt/programs/light-client", observationElfPath: "/opt/programs/observation" });
    expect(text).toContain('backend = "sp1"');
    expect(text).toContain('sp1_elf_path = "/opt/programs/light-client"');
    expect(text).toContain('sp1_observation_elf_path = "/opt/programs/observation"');
    expect(text).not.toContain("remote_url");
  });

  it("refuses a program path that would break out of its quotes", () => {
    expect(() => renderProverConfig(route, { kind: "sp1", lightClientElfPath: 'a"b', observationElfPath: "/b" })).toThrow("light client program path holds a character");
  });

  it("renderProverConfig writes the webhook target and the bearer variable name, never a token", () => {
    const text = renderProverConfig(route, remote, { webhookUrl: "https://publisher.example.org/proofs", bearerVariable: "PROOF_HANDOFF_TOKEN" });
    expect(text).toContain('targets = ["stdout", "webhook"]');
    expect(text).toContain('webhook_url = "https://publisher.example.org/proofs"');
    expect(text).toContain('webhook_bearer_env = "PROOF_HANDOFF_TOKEN"');
  });

  it("writes only the standard output target when no handoff is given", () => {
    const text = renderProverConfig(route, remote);
    expect(text).toContain('targets = ["stdout"]');
    expect(text).not.toContain("webhook");
  });

  it("passes the handoff of the wrapper into the file of a prove run", async () => {
    const { binary, seen } = await setup({ code: 3 }, { handoff: { webhookUrl: "https://publisher.example.org/proofs", bearerVariable: "PROOF_HANDOFF_TOKEN" } });
    await binary.prove({ direction: "first-to-second" });
    expect(seen[0]!.configText).toContain('webhook_bearer_env = "PROOF_HANDOFF_TOKEN"');
  });

  // A `--to` flag replaces the targets of the file. A run with a handoff that named only `--to stdout` printed its proof
  // and never posted it, so the backend kept the job proving until the lost-job check failed it.
  it("names the webhook as a target on the command line when a handoff is given", async () => {
    const { binary, seen } = await setup({ code: 3 }, { handoff: { webhookUrl: "https://publisher.example.org/proofs", bearerVariable: "PROOF_HANDOFF_TOKEN" } });
    await binary.prove({ direction: "first-to-second" });
    const { args } = seen[0]!.spec;
    expect(args.slice(args.indexOf("prove"))).toEqual(["prove", "--route", "ethereum_to_pulsechain", "--to", "stdout", "--to", "webhook"]);
  });
});

describe("the prover configuration of the oracle backend", () => {
  const route = describeRoute(pair, "first-to-second");

  it("names the key by its variable", () => {
    const text = renderProverConfig(route, { kind: "oracle", keyVariable: "ORACLE_KEY" });
    expect(text).toContain('backend = "oracle"');
    expect(text).toContain('oracle_key_env = "ORACLE_KEY"');
    expect(text).not.toContain("remote_url");
  });

  it("refuses a variable name that would break out of its quotes", () => {
    expect(() => renderProverConfig(route, { kind: "oracle", keyVariable: 'A"B' })).toThrow("oracle key variable holds a character that the prover configuration cannot carry");
  });

  it("refuses a source chain that the prover does not know, by chain identifier", () => {
    const stranger = { ...route, source: { ...route.source, chainId: 5 } };
    expect(() => renderProverConfig(stranger, null)).toThrow("the source chain id 5 is not a chain kind that the prover knows");
  });

  it("gives each testnet its own chain kind and keeps its own chain identifier", () => {
    const testnetEnvironment = {
      EXPLORER_RPC_URL_11155111: "http://127.0.0.1:5",
      EXPLORER_RPC_URL_943: "http://127.0.0.1:6",
      EXPLORER_BEACON_URL_11155111: "http://127.0.0.1:7",
      EXPLORER_BEACON_URL_943: "http://127.0.0.1:8",
    };
    const testnet = loadPair({
      pairName: "sepolia-pls943",
      environment: testnetEnvironment,
      deployment: { chain_a: section(11155111, 0x30), chain_b: section(943, 0x40) },
    });
    const forward = renderProverConfig(describeRoute(testnet, "first-to-second"), null);
    expect(forward).toContain("[routes.sepolia_to_pulsechain-testnet-v4.source]");
    expect(forward).toContain('chain = "sepolia"');
    expect(forward).not.toContain('chain = "ethereum"');
    expect(forward).toContain("chain_id = 11155111");
    expect(forward).toContain("chain_id = 943");
    const backward = renderProverConfig(describeRoute(testnet, "second-to-first"), null);
    expect(backward).toContain('chain = "pulsechain-testnet-v4"');
    expect(backward).not.toContain('chain = "pulsechain"');
    expect(backward).toContain('beacon_url = "http://127.0.0.1:8"');
  });

  it("accepts both chain kinds that the prover knows", () => {
    expect(renderProverConfig(describeRoute(pair, "second-to-first"), null)).toContain('chain = "pulsechain"');
    expect(renderProverConfig(route, null)).toContain('chain = "ethereum"');
  });
});
