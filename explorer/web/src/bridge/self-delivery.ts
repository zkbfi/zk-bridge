/**
 * Whether the connected wallet can deliver a stuck transfer itself (owner: "check the balance of the connected walet
 * and disable delivery if they do not have enough (explaining why it is disabled with a tooltip)").
 */
import { formatUnits } from "../ui/format";

/** The state of "Deliver it yourself". */
export type SelfDeliveryState = { readonly enabled: boolean; readonly reason: string | null };

/**
 * @param input The wallet's native balance on the destination chain, the gas the delivery needs (in wei), the coin and
 * the chain.
 */
export const selfDeliveryState = (input: { readonly nativeBalance: bigint | null; readonly estimatedGasWei: bigint; readonly symbol: string; readonly chainName: string }): SelfDeliveryState => {
  if (input.nativeBalance === null) return { enabled: false, reason: "Connect a wallet to deliver it yourself." };
  if (input.nativeBalance >= input.estimatedGasWei) return { enabled: true, reason: null };
  const held = formatUnits(input.nativeBalance, 18, { maximumFractionDigits: 6 });
  const needed = formatUnits(input.estimatedGasWei, 18, { maximumFractionDigits: 6 });
  const missing = formatUnits(input.estimatedGasWei - input.nativeBalance, 18, { maximumFractionDigits: 6 });
  return { enabled: false, reason: `Your wallet holds ${held} ${input.symbol} on ${input.chainName}; delivering needs about ${needed} ${input.symbol}. Add ${missing} ${input.symbol} on ${input.chainName} to deliver it yourself.` };
};
