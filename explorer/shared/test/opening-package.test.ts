import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPair, type Pair } from "../src/index.js";
import type { CommandExecutor, CommandSpec } from "../src/prover/execute-command.js";
import { openingPackageSchema } from "../src/prover/opening-package.js";
import { ProverCommandError, ProverOutputError, createProverBinary } from "../src/prover/prover-binary.js";
import { describeRoute, renderProverConfig } from "../src/prover/prover-config.js";
import { readFileSync } from "node:fs";
import { memoryLogger, word } from "./support/prover-builders.js";

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
const pair: Pair = loadPair({ environment, deployment: { chain_a: section(369, 0x20), chain_b: section(1, 0x10) } });

/** What `opening-proof` prints, trimmed to the fields the bots read plus a few that pass through. */
const openingOutput = {
  schemaVersion: 1,
  route: "pulsechain_to_ethereum",
  bridge: `0x${"21".repeat(20)}`,
  chainId: 369,
  remoteChainId: 1,
  depositsOpen: false,
  remoteBlockNumber: 1234,
  remoteBlockHash: word(7),
  verifiedNatively: true,
  proof: { remoteSlot: 640, storedSlot: 320, remoteHeaderRlp: "0x01", accountProof: [], storageProof: [] },
  calldata: "0xabcdef",
  to: `0x${"21".repeat(20)}`,
};

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(answer: { code: number; stdout?: string; stderr?: string }) {
  const directory = await mkdtemp(join(tmpdir(), "opening-"));
  scratch.push(directory);
  const seen: Array<{ spec: CommandSpec; configText: string }> = [];
  const executor: CommandExecutor = async (spec) => {
    seen.push({ spec, configText: readFileSync(spec.args[1] as string, "utf8") });
    return { code: answer.code, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  };
  const binary = createProverBinary({
    binaryPath: "/bin/zk-bridge-prover",
    pair,
    executor,
    timeoutMilliseconds: 777,
    backend: null,
    proverSecret: null,
    baseEnvironment: { PATH: "/usr/bin" },
    temporaryDirectory: join(directory, "nested"),
    logger: memoryLogger().logger,
  });
  return { binary, seen };
}

describe("openingPackageSchema", () => {
  it("reads the target, the calldata and the two slots, and keeps the other fields", () => {
    const parsed = openingPackageSchema.parse(openingOutput);
    expect(parsed).toMatchObject({ to: openingOutput.to, calldata: "0xabcdef", depositsOpen: false, remoteBlockNumber: 1234, proof: { remoteSlot: 640, storedSlot: 320 } });
    expect(parsed.chainId).toBe(369);
  });

  it("refuses an answer without calldata or with a target that is no address", () => {
    expect(openingPackageSchema.safeParse({ ...openingOutput, calldata: undefined }).success).toBe(false);
    expect(openingPackageSchema.safeParse({ ...openingOutput, to: "0x12" }).success).toBe(false);
  });
});

describe("openingProof", () => {
  it("runs opening-proof for the route of the direction, with no backend section", async () => {
    const { binary, seen } = await setup({ code: 0, stdout: `${JSON.stringify(openingOutput)}\n` });
    const result = await binary.openingProof({ direction: "first-to-second" });
    expect(result.calldata).toBe("0xabcdef");
    const { spec, configText } = seen[0]!;
    expect(spec.args).toEqual(["--config", spec.args[1], "opening-proof", "--route", describeRoute(pair, "first-to-second").name]);
    expect(configText).toBe(renderProverConfig(describeRoute(pair, "first-to-second"), null));
  });

  it("throws the command error with the tail of standard error when the prover fails", async () => {
    const { binary } = await setup({ code: 1, stderr: "rpc error 4444/-32602: distance to target block exceeds maximum proof window" });
    const failure = await binary.openingProof({ direction: "first-to-second" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProverCommandError);
    expect((failure as Error).message).toContain("maximum proof window");
  });

  it("refuses an answer of the wrong shape", async () => {
    const { binary } = await setup({ code: 0, stdout: JSON.stringify({ ...openingOutput, calldata: 5, to: "x" }) });
    const failure = await binary.openingProof({ direction: "first-to-second" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProverOutputError);
    expect((failure as Error).message.startsWith("opening-proof printed an unexpected package: ")).toBe(true);
    expect((failure as Error).message).toContain("; ");
  });
});
