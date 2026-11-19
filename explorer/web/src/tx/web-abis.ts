/**
 * The ABI fragments that the confirm dialog decodes calldata with. The terminal fragments (`@terminal/tx/abis`) cover the
 * mediator, the message bridge and the light client. The web page adds the delivery router (the native coin goes to it:
 * `relayTokensAndCall(address,bytes,uint256)` with a tip, `wrapAndRelayTokens` without), the ERC-20 approval and the deposit gate's `confirm(evidence)`, the step that confirms an
 * epoch before a send on a chain whose gate enforces.
 *
 * The three calls that the terminal ABIs lack come from the generated ABIs: `openDeposits(OpeningProof)` on the message bridge, `seal(bytes)` on the
 * deposit gate and `observe(bytes,bytes)` on the fork registry. `knownAbis` stays first, so a function that both hold decodes as before.
 *
 * The router ABI is the generated one from `@zk-bridge/shared`, so a new router function reaches the review when that ABI
 * is generated again. `test/tx/confirm-decode-every-send.test.ts` decodes every send the dapp can build.
 */
import { erc20Abi, parseAbi, type Abi } from "viem";
import { beaconForkGateAbi, deliveryRouterAbi, forkRegistryAbi, messageBridgeAbi as generatedMessageBridgeAbi } from "@zk-bridge/shared";
import { knownAbis } from "@terminal/tx/abis";

/** Every ABI that the confirm dialog can decode a transaction with. */
export const confirmableAbis: readonly Abi[] = [...knownAbis, deliveryRouterAbi, generatedMessageBridgeAbi, beaconForkGateAbi, forkRegistryAbi, erc20Abi, parseAbi(["function confirm(bytes evidence)"])];
