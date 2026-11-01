import { parseAbi } from "viem";

/**
 * The ERC-20 `Transfer` event of a bridged token, alone. The full ABI of `BridgedToken` also holds the ERC-677
 * event of the same name, which makes the name ambiguous for an indexer. A test checks that this event exists in the
 * generated ABI of `BridgedToken`.
 */
export const bridgedTokenTransferAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
