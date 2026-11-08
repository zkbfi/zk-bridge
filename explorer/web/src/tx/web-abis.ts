/**
 * The ABI fragments that the confirm dialog decodes calldata with. The terminal fragments (`@terminal/tx/abis`) cover the
 * mediator, the wrap router, the message bridge and the light client. The web page adds the ERC-20 approval and the
 * deposit gate's `confirm(evidence)`, the step that confirms an epoch before a send on a chain whose gate enforces.
 */
import { erc20Abi, parseAbi, type Abi } from "viem";
import { knownAbis } from "@terminal/tx/abis";

/** Every ABI that the confirm dialog can decode a transaction with. */
export const confirmableAbis: readonly Abi[] = [...knownAbis, erc20Abi, parseAbi(["function confirm(bytes evidence)"])];
