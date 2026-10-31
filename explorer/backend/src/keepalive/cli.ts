import type { ProofDirection } from "@zk-bridge/shared";

/** The usage text of `zk-bridge-keepalive`. */
export const USAGE = `zk-bridge-keepalive status|march [options]

Reads both light clients of a pair, judges whether each can still move, and (march) makes the proofs that move them.
Endpoints come from EXPLORER_RPC_URL_<chainId> and EXPLORER_BEACON_URL_<chainId>, or from --backend-config.

  --pair <name>                  the pair (default: the backend config's, else sepolia-pls943)
  --deployment <file>            the deployment file (default: the backend config's)
  --backend-config <file>        read pair, deploymentFile, rpcUrls, beaconUrls and limits.keepAliveSeconds from it
  --direction <d>                first-to-second, second-to-first or both (default both)
  --keep-alive-hours <h>         a head older than this needs a proof (default: the backend config's, else 12)
  --margin-hours <h>             act when the deadline is closer than this (default 6)
  --json                         status: print one JSON object instead of text
march only:
  --execute                      request or send proofs (default: print the plan only)
  --via backend|local            backend: POST <backend-url>/requests (default); local: zk-bridge-prover and cast send
  --backend-url <url>            default https://prove.zkb.fi
  --max-proofs <n>               proofs per light client per run (default 3)
  --head-timeout-minutes <m>     wait this long for the head to move after a proof (default 90)
  --job-timeout-minutes <m>      wait this long for a backend job (default 120)
  --poll-seconds <s>             default 30
  --max-retry-wait-seconds <s>   wait out a backend limit up to this long, else defer to the next run (default 300)
  --prover <bin>                 local: the zk-bridge-prover binary (default: $PROVER)
  --prover-config <file>         local: the prover configuration
  --route-first-to-second <r>    local: the prover route of first-to-second (default sepolia_to_pulsechain_testnet)
  --route-second-to-first <r>    local: the prover route of second-to-first (default pulsechain_testnet_to_sepolia)
  --account <name>               local: the Foundry keystore account that sends update (default: $KEYSTORE_NAME)

Exit codes: 0 fresh; 10 needs a keep-alive; 11 needs stepping; 12 stranded; 3 a read failed; 13 a march could not do
what was needed (failed or refused proof near the deadline, head did not move); 2 bad arguments. The worst one wins.`;

export type Command = "status" | "march";

/** The parsed command line. Unset values stay undefined so the caller can fill defaults from a file. */
export type CliOptions = {
  readonly command: Command;
  readonly pair?: string;
  readonly deployment?: string;
  readonly backendConfig?: string;
  readonly directions: readonly ProofDirection[];
  readonly keepAliveHours?: number;
  readonly marginHours: number;
  readonly json: boolean;
  readonly execute: boolean;
  readonly via: "backend" | "local";
  readonly backendUrl: string;
  readonly maxProofs: number;
  readonly headTimeoutMinutes: number;
  readonly jobTimeoutMinutes: number;
  readonly pollSeconds: number;
  readonly maxRetryWaitSeconds: number;
  readonly prover?: string;
  readonly proverConfig?: string;
  readonly routes: Readonly<Record<ProofDirection, string>>;
  readonly account?: string;
};

const FLAGS = new Set(["--json", "--execute"]);
const VALUES = new Set([
  "--pair",
  "--deployment",
  "--backend-config",
  "--direction",
  "--keep-alive-hours",
  "--margin-hours",
  "--via",
  "--backend-url",
  "--max-proofs",
  "--head-timeout-minutes",
  "--job-timeout-minutes",
  "--poll-seconds",
  "--max-retry-wait-seconds",
  "--prover",
  "--prover-config",
  "--route-first-to-second",
  "--route-second-to-first",
  "--account",
]);

/**
 * Parses the command line.
 *
 * @returns The options, or an error message that names the bad argument.
 */
export function parseArguments(argv: readonly string[], environment: Readonly<Record<string, string | undefined>> = {}): CliOptions | { readonly error: string } {
  const [command, ...rest] = argv;
  if (command !== "status" && command !== "march") return { error: "the first argument must be status or march" };
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] as string;
    if (FLAGS.has(argument)) {
      flags.add(argument);
      continue;
    }
    const value = rest[index + 1];
    if (!VALUES.has(argument)) return { error: `unknown argument ${argument}` };
    if (value === undefined) return { error: `${argument} needs a value` };
    values.set(argument, value);
    index += 1;
  }

  const number = (flag: string, fallback: number, check: (value: number) => boolean = (value) => value > 0): number | { error: string } => {
    const text = values.get(flag);
    if (text === undefined) return fallback;
    const value = Number(text);
    return Number.isFinite(value) && check(value) ? value : { error: `${flag} must be a positive number` };
  };
  const numbers = {
    marginHours: number("--margin-hours", 6, (value) => value >= 0),
    maxProofs: number("--max-proofs", 3, (value) => Number.isInteger(value) && value > 0),
    headTimeoutMinutes: number("--head-timeout-minutes", 90),
    jobTimeoutMinutes: number("--job-timeout-minutes", 120),
    pollSeconds: number("--poll-seconds", 30),
    maxRetryWaitSeconds: number("--max-retry-wait-seconds", 300, (value) => value >= 0),
    keepAliveHours: number("--keep-alive-hours", Number.NaN),
  };
  for (const value of Object.values(numbers)) if (typeof value === "object") return value;
  const parsed = numbers as { [Key in keyof typeof numbers]: number };

  const direction = values.get("--direction") ?? "both";
  if (direction !== "both" && direction !== "first-to-second" && direction !== "second-to-first") return { error: "--direction must be first-to-second, second-to-first or both" };
  const via = values.get("--via") ?? "backend";
  if (via !== "backend" && via !== "local") return { error: "--via must be backend or local" };

  return {
    command,
    pair: values.get("--pair"),
    deployment: values.get("--deployment"),
    backendConfig: values.get("--backend-config"),
    directions: direction === "both" ? ["first-to-second", "second-to-first"] : [direction],
    keepAliveHours: Number.isNaN(parsed.keepAliveHours) ? undefined : parsed.keepAliveHours,
    marginHours: parsed.marginHours,
    json: flags.has("--json"),
    execute: flags.has("--execute"),
    via,
    backendUrl: values.get("--backend-url") ?? "https://prove.zkb.fi",
    maxProofs: parsed.maxProofs,
    headTimeoutMinutes: parsed.headTimeoutMinutes,
    jobTimeoutMinutes: parsed.jobTimeoutMinutes,
    pollSeconds: parsed.pollSeconds,
    maxRetryWaitSeconds: parsed.maxRetryWaitSeconds,
    prover: values.get("--prover") ?? environment.PROVER,
    proverConfig: values.get("--prover-config"),
    routes: {
      "first-to-second": values.get("--route-first-to-second") ?? "sepolia_to_pulsechain_testnet",
      "second-to-first": values.get("--route-second-to-first") ?? "pulsechain_testnet_to_sepolia",
    },
    account: values.get("--account") ?? environment.KEYSTORE_NAME,
  };
}
