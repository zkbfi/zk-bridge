import type { Address, Hex } from "viem";
import { beaconForkGateAbi, beaconLightClientAbi, bridgedTokenAbi, messageBridgeAbi, tokenMediatorAbi } from "../abis/index.js";
import type { PairSide } from "../pairs.js";
import type { ChainReader } from "./chain-reader.js";

/**
 * Reads of the current state of the contracts. They answer from view calls, which the contract is the authority for, so
 * they need no event history. A failed call throws: a number that could not be read is never replaced by a default.
 */

/** The head that a light client stores now. */
export type StoredHead = { readonly slot: bigint; readonly executionBlockNumber: bigint };

/**
 * The newest head of the light client on a chain, or null when it stores none (slot zero).
 *
 * @param reader Reads the chain that holds the light client.
 * @param side That chain.
 */
export const readStoredHead = async (reader: ChainReader, side: PairSide): Promise<StoredHead | null> => {
  const address = side.contracts.lightClient;
  const slot = (await reader.readContract({ abi: beaconLightClientAbi, address, functionName: "head" })) as bigint;
  if (slot === 0n) return null;
  const hash = (await reader.readContract({ abi: beaconLightClientAbi, address, functionName: "executionBlockHashes", args: [slot] })) as Hex;
  const executionBlockNumber = (await reader.readContract({ abi: beaconLightClientAbi, address, functionName: "executionBlockNumber", args: [hash] })) as bigint;
  return { slot, executionBlockNumber };
};

/**
 * The execution block that a stored head holds.
 *
 * @param reader Reads the chain that holds the light client.
 * @param side That chain.
 * @param executionBlockHash The hash that a `HeadUpdated` event names.
 */
export const readExecutionBlockNumber = async (reader: ChainReader, side: PairSide, executionBlockHash: Hex): Promise<bigint> =>
  (await reader.readContract({
    abi: beaconLightClientAbi,
    address: side.contracts.lightClient,
    functionName: "executionBlockNumber",
    args: [executionBlockHash],
  })) as bigint;

/**
 * The slot of the finalized beacon block of the tracked chain, derived from its finalized execution block: the slot is
 * `(timestamp - genesis time) / seconds per slot`, with the genesis time and the slot length that the light client
 * holds. It is exact when the finalized slot has a block, which holds at an epoch boundary on all but a missed slot.
 * It is null when the node does not serve the `finalized` tag or a read fails, because a lag that cannot be measured is
 * shown as unknown.
 *
 * @param lightClientReader Reads the chain that holds the light client.
 * @param trackedReader Reads the chain that the light client tracks.
 * @param side The chain that holds the light client.
 */
export const readFinalizedSlot = async (lightClientReader: ChainReader, trackedReader: ChainReader, side: PairSide): Promise<number | null> => {
  try {
    const address = side.contracts.lightClient;
    const [genesisTime, secondsPerSlot, finalized] = await Promise.all([
      lightClientReader.readContract({ abi: beaconLightClientAbi, address, functionName: "genesisTime" }) as Promise<bigint>,
      lightClientReader.readContract({ abi: beaconLightClientAbi, address, functionName: "secondsPerSlot" }) as Promise<bigint>,
      trackedReader.getBlock({ tag: "finalized" }),
    ]);
    if (finalized.timestamp < genesisTime) return null;
    return Number((finalized.timestamp - genesisTime) / secondsPerSlot);
  } catch {
    return null;
  }
};

/** The gate and send state that the contracts report now. */
export type GateReading = {
  readonly enforcing: boolean;
  readonly sealed: boolean;
  readonly depositsOpen: boolean;
  /** The newest confirmed epoch, or null when none was confirmed. */
  readonly confirmedEpoch: bigint | null;
  /** The unix second at which that epoch started, or null when none was confirmed. */
  readonly confirmedEpochStart: bigint | null;
};

/**
 * Reads the mode flags of the gate, whether the bridge accepts sends, and the newest confirmed epoch.
 *
 * @param reader Reads the chain.
 * @param side That chain.
 */
export const readGate = async (reader: ChainReader, side: PairSide): Promise<GateReading> => {
  const gate = side.contracts.gate;
  const view = (functionName: string) => reader.readContract({ abi: beaconForkGateAbi, address: gate, functionName });
  const [enforcing, sealed, depositsOpen, confirmed, genesisTime, slotsPerEpoch, secondsPerSlot] = await Promise.all([
    view("enforcing") as Promise<boolean>,
    view("isSealed") as Promise<boolean>,
    reader.readContract({ abi: messageBridgeAbi, address: side.contracts.bridge, functionName: "depositsOpen" }) as Promise<boolean>,
    view("confirmedEpoch") as Promise<readonly [bigint, boolean]>,
    view("genesisTime") as Promise<bigint>,
    view("slotsPerEpoch") as Promise<bigint>,
    view("secondsPerSlot") as Promise<bigint>,
  ]);
  const [epoch, exists] = confirmed;
  return {
    enforcing,
    sealed,
    depositsOpen,
    confirmedEpoch: exists ? epoch : null,
    confirmedEpochStart: exists ? genesisTime + epoch * slotsPerEpoch * secondsPerSlot : null,
  };
};

/** What the mediator reports about one token on one chain. */
export type MediatorReading = {
  /** `mediatorBalance(token)`: the tokens locked for holders of the bridged copy. */
  readonly escrow: bigint;
};

/**
 * Reads the escrow balance of a token from the mediator of its chain.
 *
 * @param reader Reads the chain.
 * @param side That chain.
 * @param token The token.
 */
export const readMediatorBalances = async (reader: ChainReader, side: PairSide, token: Address): Promise<MediatorReading> => {
  const escrow = (await reader.readContract({ abi: tokenMediatorAbi, address: side.contracts.mediator, functionName: "mediatorBalance", args: [token] })) as bigint;
  return { escrow };
};

/** The bridged copy of a native token on the other chain, checked in both directions. */
export type CopyReading = { readonly token: Address; readonly supply: bigint };

/**
 * Finds the bridged copy of a native token and reads its supply. The mediator of the other chain predicts the copy
 * address. The copy exists only when the same mediator names the native token for that copy, so the function reads the
 * relationship back instead of trusting the predicted address.
 *
 * @param otherReader Reads the other chain.
 * @param otherSide The other chain.
 * @param native The native token on its home chain.
 * @returns The copy and its total supply, or null when no copy is registered.
 */
export const readBridgedCopy = async (otherReader: ChainReader, otherSide: PairSide, native: Address): Promise<CopyReading | null> => {
  const mediator = otherSide.contracts.mediator;
  const predicted = ((await otherReader.readContract({ abi: tokenMediatorAbi, address: mediator, functionName: "bridgedTokenAddress", args: [native] })) as string).toLowerCase() as Address;
  const named = (await otherReader.readContract({ abi: tokenMediatorAbi, address: mediator, functionName: "nativeTokenAddress", args: [predicted] })) as string;
  if (named.toLowerCase() !== native.toLowerCase()) return null;
  const supply = (await otherReader.readContract({ abi: bridgedTokenAbi, address: predicted, functionName: "totalSupply" })) as bigint;
  return { token: predicted, supply };
};
