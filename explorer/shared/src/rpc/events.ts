import { getAbiItem, type AbiEvent } from "viem";
import { beaconForkGateAbi, beaconLightClientAbi, messageBridgeAbi, tokenMediatorAbi } from "../abis/index.js";
import type { PairSide } from "../pairs.js";
import type { LogSource } from "./chain-scan.js";

const eventOf = (abi: readonly unknown[], name: string): AbiEvent =>
  getAbiItem({ abi: abi as never, name } as never) as unknown as AbiEvent;

/** The events of the bridge that the source reads. */
export const BRIDGE_EVENTS = ["UserRequestForAffirmation", "AffirmationCompleted"] as const;

/** The events of the token mediator that the source reads. */
export const MEDIATOR_EVENTS = [
  "TokensBridgingInitiated",
  "TokensBridged",
  "NewTokenRegistered",
  "FallbackUsed",
  "ClaimableRecorded",
  "Claimed",
  "CallbackFailed",
] as const;

/** The events of the gate that the source reads. */
export const GATE_EVENTS = ["ForkConfirmed", "GateSealedByFork"] as const;

/**
 * The contracts and events to read on one chain: the bridge, the token mediator, the light client and the gate. These
 * are the events that the indexer handlers read, except the supply transfers of bridged tokens, because the RPC source
 * reads `totalSupply()` instead.
 *
 * @param side One side of the pair.
 */
export const logSourcesOf = (side: PairSide): readonly LogSource[] => [
  { address: side.contracts.bridge, events: BRIDGE_EVENTS.map((name) => eventOf(messageBridgeAbi, name)) },
  { address: side.contracts.mediator, events: MEDIATOR_EVENTS.map((name) => eventOf(tokenMediatorAbi, name)) },
  { address: side.contracts.lightClient, events: [eventOf(beaconLightClientAbi, "HeadUpdated")] },
  { address: side.contracts.gate, events: GATE_EVENTS.map((name) => eventOf(beaconForkGateAbi, name)) },
];
