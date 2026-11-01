import { formatEther, parseEther } from "viem";
import { labelOf, symbolOf, type Deps } from "../deps.ts";
import type { CheckSpec } from "../types.ts";

/** A balance with at most four decimals, such as `0.4521`. */
const amount = (wei: bigint): string => {
  const text = formatEther(wei);
  const [whole = "0", fraction = ""] = text.split(".");
  const short = fraction.slice(0, 4).replace(/0+$/, "");
  return short === "" ? whole : `${whole}.${short}`;
};

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** One check for each wallet and each chain it has a minimum for: the native balance against the minimum. */
export function walletChecks(deps: Deps): CheckSpec<Deps>[] {
  const order = deps.pair.sides.map((side) => side.chainId);
  return deps.config.wallets.flatMap((wallet) =>
    Object.entries(wallet.low)
      .sort(([left], [right]) => order.indexOf(Number(left)) - order.indexOf(Number(right)))
      .map(([chain, minimum]): CheckSpec<Deps> => {
      const chainId = Number(chain);
      return {
        id: `wallet-${wallet.name}-${chainId}`,
        name: `${capitalise(wallet.name)} wallet on ${labelOf(deps, chainId)}`,
        section: "wallets",
        async run(run) {
          const balance = await run.client(chainId).getBalance({ address: wallet.address as `0x${string}` });
          const symbol = symbolOf(run, chainId);
          const where = `${amount(balance)} ${symbol}`;
          if (balance === 0n) return { state: "down", detail: `${where}, the wallet is empty` };
          if (balance < parseEther(minimum)) return { state: "degraded", detail: `${where}, under the ${minimum} ${symbol} minimum` };
          return { state: "ok", detail: where };
        },
      };
    }),
  );
}
