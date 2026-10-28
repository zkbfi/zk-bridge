import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeLightClientOutput, encodeProofMessage, loadPair, type Pair } from "../src/index.js";
import type { Hex } from "viem";
import { executeCommand } from "../src/prover/execute-command.js";
import { ProverCommandError, createProverBinary } from "../src/prover/prover-binary.js";
import { describeRoute, renderProverConfig } from "../src/prover/prover-config.js";
import { assessProofPayload } from "../src/prover/proof-intake.js";
import { fakeLightClient, memoryLogger } from "./support/prover-builders.js";

const REPOSITORY = new URL("../../../", import.meta.url).pathname;
const REAL_BINARY = join(REPOSITORY, "prover/target/release/zk-bridge-prover");
const FIXTURE = join(REPOSITORY, "test/hardened/fixtures/sp1-proof-ethereum-update.json");

function section(chainId: number, seed: number) {
  const address = (offset: number) => `0x${(seed + offset).toString(16).padStart(2, "0").repeat(20)}`;
  return {
    chain_id: chainId,
    bridge: address(1),
    mediator: address(2),
    token_factory: address(3),
    wrapped_native: address(5),
    gate: address(6),
    light_client: address(7),
    start_block: 5,
  };
}
const deployment = { chain_a: section(1, 0x10), chain_b: section(369, 0x20) };
const environment = {
  EXPLORER_RPC_URL_1: "http://127.0.0.1:1",
  EXPLORER_RPC_URL_369: "http://127.0.0.1:2",
  EXPLORER_BEACON_URL_1: "http://127.0.0.1:3",
  EXPLORER_BEACON_URL_369: "http://127.0.0.1:4",
};
const pair: Pair = loadPair({ environment, deployment });
const remote = { kind: "remote", mode: { mode: "load-balancing" }, endpoint: "https://worker.example.org", apiKeyVariable: "RUNPOD_API_KEY" } as const;

describe("the prover configuration file", () => {
  it("names the route after the two sides and the key by its variable", () => {
    const route = describeRoute(pair, "second-to-first");
    expect(route.name).toBe("pulsechain_to_ethereum");
    const text = renderProverConfig(route, remote);
    expect(text).toContain("[routes.pulsechain_to_ethereum.source]");
    expect(text).toContain('chain = "pulsechain"');
    expect(text).toContain("chain_id = 369");
    expect(text).toContain('remote_api_key_env = "RUNPOD_API_KEY"');
    expect(text).toContain("light_client = ");
  });

  it("leaves the backend out for the commands that need none", () => {
    expect(renderProverConfig(describeRoute(pair, "first-to-second"), null)).not.toContain("[prover]");
  });

  it("refuses a value that would break out of its quotes", () => {
    const tricky = loadPair({ environment: { ...environment, EXPLORER_RPC_URL_1: 'http://127.0.0.1:1/"\nbackend = "oracle' }, deployment });
    expect(() => renderProverConfig(describeRoute(tricky, "first-to-second"), null)).toThrow(/cannot carry/);
  });

  it("refuses a source without a beacon endpoint", () => {
    const without = loadPair({ environment: { ...environment, EXPLORER_BEACON_URL_1: "" }, deployment });
    expect(() => renderProverConfig(describeRoute(without, "first-to-second"), null)).toThrow(/no beacon endpoint/);
  });
});

describe.skipIf(!existsSync(REAL_BINARY))("the real zk-bridge-prover binary (build it with `cargo build --release` in prover/)", () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "prover-real-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const binary = () =>
    createProverBinary({
      binaryPath: REAL_BINARY,
      pair,
      executor: executeCommand,
      timeoutMilliseconds: 60_000,
      backend: remote,
      proverSecret: { variable: "RUNPOD_API_KEY", value: "rpa_TESTONLY1234567890abcdefghijkl" },
      baseEnvironment: { PATH: process.env.PATH ?? "" },
      temporaryDirectory: directory,
      logger: memoryLogger().logger,
    });

  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { programVKey: Hex; publicValues: Hex; proof: Hex };

  it("reads the configuration that the bot renders (the first failure is the refused connection, not the file)", async () => {
    await expect(binary().evidence({ direction: "first-to-second", transactionHash: `0x${"ab".repeat(32)}`, logIndex: 0 })).rejects.toThrow(/Connection refused/);
  });

  it("verifies a real Groth16 proof", async () => {
    await expect(binary().verify({ programKey: fixture.programVKey, publicValues: fixture.publicValues, proof: fixture.proof })).resolves.toBeUndefined();
  });

  it("refuses a proof with one changed byte, a changed key and changed public values", async () => {
    const flip = (hex: Hex): Hex => `${hex.slice(0, -2)}${(Number.parseInt(hex.slice(-2), 16) ^ 1).toString(16).padStart(2, "0")}` as Hex;
    const good = { programKey: fixture.programVKey, publicValues: fixture.publicValues, proof: fixture.proof };
    for (const bad of [{ ...good, proof: flip(good.proof) }, { ...good, programKey: `0x${"42".repeat(32)}` as Hex }, { ...good, publicValues: flip(good.publicValues) }]) {
      await expect(binary().verify(bad)).rejects.toBeInstanceOf(ProverCommandError);
    }
  });

  it("lets the runner accept a real proof message and refuse the same message with a damaged proof", async () => {
    const output = decodeLightClientOutput(fixture.publicValues);
    const message = {
      version: 1 as const,
      pair: "eth-pls",
      direction: "first-to-second" as const,
      programKey: fixture.programVKey,
      startSlot: output.previousHeadSlot,
      startRoot: output.previousHeaderRoot,
      newSlot: output.newHeadSlot,
      newRoot: output.newHeaderRoot,
      publicValues: fixture.publicValues,
      proof: fixture.proof,
    };
    const lightClient = fakeLightClient({ headSlot: output.previousHeadSlot, headRoot: output.previousHeaderRoot, programKey: fixture.programVKey });
    const common = { pairName: "eth-pls", direction: "first-to-second" as const, lightClient, prover: binary() };
    expect(await assessProofPayload({ ...common, payload: encodeProofMessage(message) })).toMatchObject({ accept: true });
    const damaged = encodeProofMessage({ ...message, proof: `0x${fixture.proof.slice(2, -2)}00` });
    expect(await assessProofPayload({ ...common, payload: damaged })).toMatchObject({ accept: false, reason: "proof-does-not-verify" });
  });

  it("removes its configuration directory after each run", async () => {
    const { readdir } = await import("node:fs/promises");
    await writeFile(join(directory, "marker"), "");
    expect(await readdir(directory)).toEqual(["marker"]);
  });
});
