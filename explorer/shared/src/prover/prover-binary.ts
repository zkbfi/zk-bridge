import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import type { Pair } from "../pairs.js";
import type { ProofDirection } from "../proof-message.js";
import type { LogSink } from "../log-sink.js";
import type { CommandExecutor } from "./execute-command.js";
import {
  evidencePackageSchema,
  proofPackageSchema,
  verifyResultSchema,
  type EvidencePackage,
  type ProofPackage,
} from "./packages.js";
import { parseProveTiming } from "./prove-timing.js";
import { describeRoute, renderProverConfig, type BackendSection, type HandoffSection } from "./prover-config.js";

/** The exit code of `prove` when the starting head already is the newest final header. */
export const EXIT_UP_TO_DATE = 3;

/** The result of one `prove` run. */
export type ProveOutcome =
  | { readonly kind: "proof"; readonly proofPackage: ProofPackage }
  | { readonly kind: "up-to-date" };

/** A prover command failed. `detail` holds the tail of its standard error. The logger redacts it before it is written. */
export class ProverCommandError extends Error {
  override readonly name = "ProverCommandError";
  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly detail: string,
  ) {
    super(`zk-bridge-prover ${command} exited with code ${exitCode}: ${detail}`);
  }
}

/** The prover printed something that is not the documented shape. */
export class ProverOutputError extends Error {
  override readonly name = "ProverOutputError";
}

/** The proof or the evidence request for one direction. */
export interface DirectionRequest {
  readonly direction: ProofDirection;
}

/** The evidence request: the message is named by its source transaction and the index of its log. */
export interface EvidenceRequest extends DirectionRequest {
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

/** The proof to check. */
export interface VerifyRequest {
  readonly programKey: Hex;
  readonly publicValues: Hex;
  readonly proof: Hex;
}

/** The three commands of `zk-bridge-prover` that the bots use. */
export interface ProverBinary {
  /** `prove --route <route> --to stdout`, plus `--to webhook` with a handoff. Exit code 3 gives `up-to-date`. */
  prove(request: DirectionRequest): Promise<ProveOutcome>;
  /** `evidence --route <route> --tx <hash> --log-index <n>`. */
  evidence(request: EvidenceRequest): Promise<EvidencePackage>;
  /** `verify`. Resolves when the proof verifies. @throws ProverCommandError when it does not. */
  verify(request: VerifyRequest): Promise<void>;
}

/** Input of {@link createProverBinary}. */
export interface ProverBinaryInput {
  readonly binaryPath: string;
  readonly pair: Pair;
  readonly executor: CommandExecutor;
  readonly timeoutMilliseconds: number;
  /** The `prove` backend. Null for a runner, which never proves. */
  readonly backend: BackendSection | null;
  /** Also send each proof package to a webhook. The bearer token travels in `baseEnvironment`, never in the file. */
  readonly handoff?: HandoffSection;
  /** The variable and value that the prover reads its proving key from. Passed in the child environment only. */
  readonly proverSecret: { readonly variable: string; readonly value: string } | null;
  /** The variables that the child needs to find its libraries, such as `PATH`. */
  readonly baseEnvironment: Readonly<Record<string, string>>;
  readonly temporaryDirectory?: string;
  /** A directory where the prover keeps the beacon states it verified, so a later run never needs an old state from a node. */
  readonly stateCacheDirectory?: string;
  readonly logger: LogSink;
}

const STDERR_TAIL = 1500;

/** The last part of a standard error text. The prover logs one line per event, so the tail holds the cause. */
function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= STDERR_TAIL ? trimmed : trimmed.slice(-STDERR_TAIL);
}

function parseSingleJsonLine(stdout: string, command: string): unknown {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  if (lines.length !== 1) throw new ProverOutputError(`${command} printed ${lines.length} lines on standard output, expected one`);
  try {
    return JSON.parse(lines[0] as string);
  } catch {
    throw new ProverOutputError(`${command} printed a line that is not JSON`);
  }
}

/**
 * Builds the prover wrapper. Each run that needs a route renders a prover configuration file into a fresh directory
 * of mode 0700, writes it with mode 0600, and removes the directory when the command ends. The proving key goes to
 * the child through the environment variable that the file names. No secret is ever an argument.
 */
export function createProverBinary(input: ProverBinaryInput): ProverBinary {
  const environment: Record<string, string> = { ...input.baseEnvironment };
  if (input.proverSecret !== null) environment[input.proverSecret.variable] = input.proverSecret.value;

  async function withConfigFile<Result>(direction: ProofDirection, backend: BackendSection | null, use: (path: string, route: string) => Promise<Result>): Promise<Result> {
    const route = describeRoute(input.pair, direction);
    const parent = input.temporaryDirectory ?? tmpdir();
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(parent, "zk-bridge-bot-"));
    try {
      const path = join(directory, "prover.toml");
      const options = input.stateCacheDirectory === undefined ? {} : { stateCacheDirectory: input.stateCacheDirectory };
      await writeFile(path, renderProverConfig(route, backend, input.handoff, options), { mode: 0o600 });
      return await use(path, route.name);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function run(command: string, args: readonly string[]) {
    input.logger.debug("prover_command", { command, args });
    return input.executor({
      command: input.binaryPath,
      args,
      environment,
      timeoutMilliseconds: input.timeoutMilliseconds,
    });
  }

  return {
    async prove(request) {
      if (input.backend === null) throw new Error("this prover wrapper has no proving backend");
      const backend = input.backend;
      return withConfigFile(request.direction, backend, async (path, route) => {
        // A `--to` flag replaces the targets of the file, so the webhook must be named here too, or it gets no post.
        const targets = input.handoff === undefined ? ["--to", "stdout"] : ["--to", "stdout", "--to", "webhook"];
        const output = await run("prove", ["--config", path, "prove", "--route", route, ...targets]);
        if (output.code === EXIT_UP_TO_DATE) return { kind: "up-to-date" } as const;
        if (output.code !== 0) throw new ProverCommandError("prove", output.code, tailOf(output.stderr));
        const parsed = proofPackageSchema.safeParse(parseSingleJsonLine(output.stdout, "prove"));
        if (!parsed.success) throw new ProverOutputError(`prove printed an unexpected package: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
        // The prover logs its step timings on standard error. A success logs them too, so that the duration of a proof and
        // the share of the wait for a GPU worker can be read from real jobs. An older prover writes none.
        const timing = parseProveTiming(output.stderr);
        input.logger.info("job_proved", {
          route,
          newHeadSlot: parsed.data.newHeadSlot,
          timingReported: timing !== null,
          ...timing,
        });
        return { kind: "proof", proofPackage: parsed.data } as const;
      });
    },
    async evidence(request) {
      return withConfigFile(request.direction, null, async (path, route) => {
        const output = await run("evidence", [
          "--config",
          path,
          "evidence",
          "--route",
          route,
          "--tx",
          request.transactionHash,
          "--log-index",
          String(request.logIndex),
        ]);
        if (output.code !== 0) throw new ProverCommandError("evidence", output.code, tailOf(output.stderr));
        const parsed = evidencePackageSchema.safeParse(parseSingleJsonLine(output.stdout, "evidence"));
        if (!parsed.success) throw new ProverOutputError(`evidence printed an unexpected package: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
        return parsed.data;
      });
    },
    async verify(request) {
      const output = await run("verify", [
        "verify",
        "--program-vkey",
        request.programKey,
        "--public-values",
        request.publicValues,
        "--proof",
        request.proof,
      ]);
      if (output.code !== 0) throw new ProverCommandError("verify", output.code, tailOf(output.stderr));
      const parsed = verifyResultSchema.safeParse(parseSingleJsonLine(output.stdout, "verify"));
      if (!parsed.success) throw new ProverOutputError("verify printed an unexpected answer");
    },
  };
}
