/**
 * The ABI fragments that the confirm dialog decodes calldata with. The terminal fragments (`@terminal/tx/abis`) cover the
 * mediator, the wrap router, the message bridge and the light client. The web page adds the ERC-20 approval.
 */
import { erc20Abi, type Abi } from "viem";
import { knownAbis } from "@terminal/tx/abis";

/** Every ABI that the confirm dialog can decode a transaction with. */
export const confirmableAbis: readonly Abi[] = [...knownAbis, erc20Abi];
