/**
 * The destination row (owner, quotes 96–97): locked, the transfer goes to the connected wallet and follows it; unlocked,
 * it goes to the address typed in place, whatever wallet is connected. These rules check the typed address.
 */
import { isAddress } from "viem";

const ZERO = /^0x0{40}$/i;

/**
 * Why a typed destination cannot be used, or null when it can: empty, not an address, the zero address, or a mixed-case
 * address whose capitals do not match its checksum.
 *
 * @param text The address as typed.
 */
export const destinationProblem = (text: string): string | null => {
  const trimmed = text.trim();
  if (trimmed === "") return "Type the destination address, or lock the row to send to your wallet.";
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return "An address is 0x followed by 40 hex characters.";
  if (ZERO.test(trimmed)) return "That is the zero address. Nothing sent there can be spent.";
  if (!isAddress(trimmed, { strict: true })) return "The capital letters don't match the address's checksum. Check it, or type it in lower case.";
  return null;
};

/** The lock's tooltip in each state. */
export const LOCK_TIPS = {
  locked: "Sends to your connected wallet",
  unlocked: "Sends to the address you type, whatever wallet is connected",
} as const;
