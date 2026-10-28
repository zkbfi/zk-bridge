/**
 * Wrappers of the commands of `zk-bridge-prover`. Each one runs the binary, reads the JSON on standard output and keeps
 * the log of standard error in the state directory. The RunPod key stays in the environment of the process: it is never
 * an argument, and the binary never prints it.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { Context } from "./context.ts";

/** The proof package that `prove` prints. The shape is in `prover/README.md`. */
export interface ProofPackage {
  readonly route: string;
  readonly programKey: Hex;
  readonly startHeadSlot: number;
  readonly newHeadSlot: number;
  readonly latestFinalizedSlot: number;
  readonly publicValues: Hex;
  readonly proof: Hex;
  readonly updateCalldata: Hex;
  readonly backend: string;
  readonly destination: { readonly chainId: number; readonly lightClient: Address };
}

/** One call of the evidence result. */
export interface EvidenceCall {
  readonly to: Address;
  readonly data: Hex;
}

/** The evidence that `evidence` prints, as far as the driver reads it. */
export interface Evidence {
  readonly message: { readonly messageId: Hex; readonly sourceBlockNumber: number; readonly sourceSlot: number };
  readonly anchor: { readonly slot: number; readonly root: Hex };
  readonly deliveryStatus: "notDelivered" | "succeeded" | "failed";
  readonly alreadyDelivered: boolean;
  readonly execute: EvidenceCall;
  readonly prerequisites: readonly (EvidenceCall & { readonly function: string; readonly reason: string })[];
}

/** The result of a command: the exit code, the text of both streams and the wall time. */
interface CommandResult {
  readonly code: number;
  readonly output: string;
  readonly errors: string;
  readonly seconds: number;
}

const run = async (context: Context, label: string, args: readonly string[]): Promise<CommandResult> => {
  const started = Date.now();
  const child = Bun.spawn([context.proverBinary, "--config", context.proverConfig, ...args], { stdout: "pipe", stderr: "pipe", env: process.env });
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  appendFileSync(join(context.stateDirectory, "prover.log"), `--- ${label} (exit ${code})\n${errors}\n`);
  return { code, output, errors, seconds: (Date.now() - started) / 1000 };
};

/** The outcome of `prove`: a package, or the news that the head is already the newest final header. */
export type ProveOutcome =
  | { readonly kind: "proof"; readonly proof: ProofPackage; readonly seconds: number }
  | { readonly kind: "nothing-to-prove" };

/**
 * Runs `prove` for a route. The exit code 3 means that the light client holds the newest final header.
 *
 * @throws Error with the last lines of standard error on any other failure.
 */
export const prove = async (context: Context, route: string): Promise<ProveOutcome> => {
  const result = await run(context, `prove ${route}`, ["prove", "--route", route, "--to", "stdout"]);
  if (result.code === 3) return { kind: "nothing-to-prove" };
  if (result.code !== 0) throw new Error(`prove ${route} failed with exit code ${result.code}: ${tail(result.errors)}`);
  const proof = JSON.parse(result.output) as ProofPackage;
  writeFileSync(join(context.stateDirectory, `proof-${route}-${proof.newHeadSlot}.json`), result.output);
  return { kind: "proof", proof, seconds: result.seconds };
};

/** Runs `evidence` for one message. */
export const evidence = async (context: Context, input: { readonly route: string; readonly transactionHash: Hex; readonly logIndex: number }): Promise<Evidence> => {
  const result = await run(context, `evidence ${input.transactionHash}`, [
    "evidence",
    "--route",
    input.route,
    "--tx",
    input.transactionHash,
    "--log-index",
    String(input.logIndex),
  ]);
  if (result.code !== 0) throw new Error(`evidence ${input.transactionHash} failed with exit code ${result.code}: ${tail(result.errors)}`);
  return JSON.parse(result.output) as Evidence;
};

/** The opening proof: the bridge to call and the calldata. */
export interface OpeningProof {
  readonly to: Address;
  readonly calldata: Hex;
}

/** Runs `opening-proof` for a route. */
export const openingProof = async (context: Context, route: string): Promise<OpeningProof> => {
  const result = await run(context, `opening-proof ${route}`, ["opening-proof", "--route", route]);
  if (result.code !== 0) throw new Error(`opening-proof ${route} failed with exit code ${result.code}: ${tail(result.errors)}`);
  return JSON.parse(result.output) as OpeningProof;
};

const tail = (text: string): string => text.trim().split("\n").slice(-4).join(" | ").slice(0, 600);
