/**
 * The tip verdict fixture (vectors/tip-verdict-vectors.json) as values, and a fake PulseChain client over its pools.
 * The core, the backend, the runner and the dapp tests all read the pools through this client, each through its own
 * path, so they share one fixture. Self-contained (no import of the core), so any package's test can use it.
 */
import vectors from "../../vectors/tip-verdict-vectors.json" with { type: "json" };

type Hex = `0x${string}`;

/** The fixture as it is written. */
export const tipVectors = vectors;

/** One case of the fixture. */
export type TipCase = (typeof vectors.cases)[number];

/** A token of the fixture: its address, decimals and origin. */
export type TipToken = { readonly address: Hex; readonly decimals: number; readonly origin: { readonly chainId: number; readonly address: Hex } | null };

/** The PulseChain block the pools are read at. */
export const FIXTURE_BLOCK = BigInt(vectors.block);

/** The delivery cost estimate of the fixture, as numbers. */
export const FIXTURE_COST = { gasUsed: BigInt(vectors.cost.gasUsed), baseFeeWei: BigInt(vectors.cost.baseFeeWei), priorityFeeWei: BigInt(vectors.cost.priorityFeeWei) };

/** The chains of a case: the source, the destination and the destination's wrapped native coin. */
export const chainsOf = (entry: TipCase): { readonly sourceChainId: number; readonly destinationChainId: number; readonly wrappedNative: Hex } =>
  vectors.chains[entry.chain as keyof typeof vectors.chains] as { sourceChainId: number; destinationChainId: number; wrappedNative: Hex };

/** The token of a case. */
export const tokenOf = (entry: TipCase): TipToken => vectors.tokens[entry.token as keyof typeof vectors.tokens] as TipToken;

/** The amount of a case, in base units. */
export const amountOf = (entry: TipCase): bigint => BigInt(entry.amount);

/** A percentage as text ("0.5") as a share × 1e18. */
const shareOfPercent = (percent: string): bigint => {
  const [whole, fraction = ""] = percent.split(".");
  return BigInt(`${whole}${fraction.padEnd(16, "0")}`);
};

/** The recipient every fixture director names. */
export const FIXTURE_RECIPIENT: Hex = "0x0000000000000000000000000000000000000012";

/**
 * The fee director of a case: a share (`MULTIPLIER_OF_TOTAL`, 8), a fixed tip (`FIXED_FEE`, 1), or none (a fixed tip of 0).
 */
export const directorOf = (entry: TipCase): { readonly recipient: Hex; readonly settings: bigint; readonly limit: bigint; readonly multiplier: bigint; readonly callGas: bigint } => {
  const tip = entry.tip as { kind: "share"; percent: string } | { kind: "fixed"; units: string } | { kind: "none" };
  if (tip.kind === "share") return { recipient: FIXTURE_RECIPIENT, settings: 8n, limit: 0n, multiplier: shareOfPercent(tip.percent), callGas: 0n };
  return { recipient: FIXTURE_RECIPIENT, settings: 1n, limit: tip.kind === "fixed" ? BigInt(tip.units) : 0n, multiplier: 0n, callGas: 0n };
};

/** The tip a case's terms take from its amount, in base units (a share or fixed tip ignores the gas). */
export const tipUnitsOf = (entry: TipCase): bigint => {
  const director = directorOf(entry);
  const amount = amountOf(entry);
  const fee = director.settings === 8n ? (amount * director.multiplier) / 10n ** 18n : director.limit;
  return fee > amount ? amount : fee;
};

const ZERO: Hex = "0x0000000000000000000000000000000000000000";
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A request that did not get through, as a fetch failure looks (not a chain answer). */
export class FixtureUnreachableError extends Error {
  override readonly name = "HttpRequestError";
}

/** A call of viem's `readContract`, as far as the fake reads it. */
type Call = { readonly address: string; readonly functionName: string; readonly args?: readonly unknown[]; readonly blockNumber?: bigint };

/**
 * A fake PulseChain client over the fixture's pools: `getPair`, `getReserves`, `token0`, `bridgedTokenAddress` (none) and
 * the latest block. `unreachable`: every read fails as a dropped request does. `calls` lists what was read.
 *
 * @param options Whether the client is unreachable.
 */
export const fixtureClient = (options: { readonly unreachable?: boolean } = {}) => {
  const calls: Call[] = [];
  return {
    calls,
    getBlockNumber: async (): Promise<bigint> => {
      if (options.unreachable === true) throw new FixtureUnreachableError("fetch failed");
      return FIXTURE_BLOCK;
    },
    readContract: async (call: Call): Promise<unknown> => {
      calls.push(call);
      if (options.unreachable === true) throw new FixtureUnreachableError("fetch failed");
      if (call.functionName === "getPair") {
        const [a, b] = call.args as [string, string];
        const pool = vectors.pools.find((entry) => same(entry.factory, call.address) && ((same(entry.token0, a) && same(entry.token1, b)) || (same(entry.token0, b) && same(entry.token1, a))));
        return pool?.pair ?? ZERO;
      }
      if (call.functionName === "bridgedTokenAddress") return ZERO;
      const pool = vectors.pools.find((entry) => same(entry.pair, call.address));
      if (pool === undefined) throw new Error(`no pool ${call.address}`);
      if (call.functionName === "token0") return pool.token0;
      return [BigInt(pool.reserve0), BigInt(pool.reserve1), 0];
    },
  };
};
