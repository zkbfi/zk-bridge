import { createConfig, factory } from "ponder";
import { getAbiItem, zeroAddress, type Address } from "viem";
import {
  beaconForkGateAbi,
  beaconLightClientAbi,
  bridgedTokenTransferAbi,
  forkRegistryAbi,
  messageBridgeAbi,
  tokenMediatorAbi,
  type PairSide,
} from "@zk-bridge/shared";
import { pair } from "./src/lib/pair";

/** How many blocks apart the chain tip handler runs. A smaller number refreshes `waiting_for_finality` sooner. */
const TIP_INTERVAL_BLOCKS = Number(process.env.EXPLORER_TIP_INTERVAL_BLOCKS ?? 5);

/** Maps each side of the pair to `{ address, startBlock }` for one contract. Sides without the contract are left out. */
const chainEntries = (select: (side: PairSide) => Address | null) =>
  Object.fromEntries(
    pair.sides.flatMap((side) => {
      const address = select(side);
      return address === null ? [] : [[side.name, { address, startBlock: side.startBlock }]];
    }),
  );

const mediatorFactoryEvent = getAbiItem({ abi: tokenMediatorAbi, name: "NewTokenRegistered" });

/** For each side, the bridged copies: every address that the mediator announced with `NewTokenRegistered`. */
const bridgedCopyChains = Object.fromEntries(
  pair.sides.map((side) => [
    side.name,
    {
      address: factory({ address: side.contracts.mediator, event: mediatorFactoryEvent, parameter: "bridgedToken" }),
      startBlock: side.startBlock,
    },
  ]),
);

/** Whether any side of the pair has a fork registry. Only PulseChain does. */
const hasRegistry = pair.sides.some((side) => side.contracts.forkRegistry !== null);

const forkRegistryContract = (
  hasRegistry ? { ForkRegistry: { abi: forkRegistryAbi, chain: chainEntries((side) => side.contracts.forkRegistry) } } : {}
) as { ForkRegistry: { abi: typeof forkRegistryAbi; chain: ReturnType<typeof chainEntries> } };

export default createConfig({
  // Each chain is indexed on its own clock. Handlers merge facts from either chain in any order, so the indexer does
  // not need Ponder's cross-chain order, and an idle chain never holds back the other one.
  ordering: "multichain",
  chains: Object.fromEntries(pair.sides.map((side) => [side.name, { id: side.chainId, rpc: side.rpcUrl }])),
  contracts: {
    MessageBridge: { abi: messageBridgeAbi, chain: chainEntries((side) => side.contracts.bridge) },
    TokenMediator: { abi: tokenMediatorAbi, chain: chainEntries((side) => side.contracts.mediator) },
    // The bridged copies. A copy exists once the mediator registers it, so each entry finds its addresses through the
    // factory event. Mints and burns are two entries because each filters on one indexed argument.
    BridgedTokenMints: {
      abi: bridgedTokenTransferAbi,
      chain: bridgedCopyChains,
      filter: { event: "Transfer", args: { from: zeroAddress } },
    },
    BridgedTokenBurns: {
      abi: bridgedTokenTransferAbi,
      chain: bridgedCopyChains,
      filter: { event: "Transfer", args: { to: zeroAddress } },
    },
    BeaconLightClient: {
      abi: beaconLightClientAbi,
      includeTransactionReceipts: true,
      chain: chainEntries((side) => side.contracts.lightClient),
    },
    BeaconForkGate: { abi: beaconForkGateAbi, chain: chainEntries((side) => side.contracts.gate) },
    // Always typed, so that handlers type check. The handler registers only when a side has a registry.
    ...forkRegistryContract,
  },
  blocks: {
    ChainTip: {
      chain: Object.fromEntries(
        pair.sides.map((side) => [side.name, { startBlock: side.startBlock, interval: TIP_INTERVAL_BLOCKS }]),
      ),
    },
  },
});
