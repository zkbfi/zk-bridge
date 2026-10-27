import { describe, expect, it } from "vitest";
import { getAbiItem, toEventSelector } from "viem";
import {
  beaconForkGateAbi,
  beaconLightClientAbi,
  bridgedTokenAbi,
  bridgedTokenTransferAbi,
  forkRegistryAbi,
  messageBridgeAbi,
  tokenMediatorAbi,
} from "../src/index.js";

const eventNames = (abi: readonly { type: string; name?: string }[]) =>
  abi.filter((item) => item.type === "event").map((item) => item.name);

describe("generated ABIs hold the events that the indexer reads", () => {
  it("MessageBridge", () => {
    expect(eventNames(messageBridgeAbi)).toEqual(expect.arrayContaining(["UserRequestForAffirmation", "AffirmationCompleted", "DepositsOpened"]));
  });
  it("TokenMediator", () => {
    expect(eventNames(tokenMediatorAbi)).toEqual(
      expect.arrayContaining([
        "TokensBridgingInitiated",
        "TokensBridged",
        "NewTokenRegistered",
        "ReleaseFailed",
        "CallbackFailed",
      ]),
    );
  });
  it("TokenMediator has no fallback and no claim event", () => {
    expect(eventNames(tokenMediatorAbi)).not.toContain("FallbackUsed");
    expect(eventNames(tokenMediatorAbi)).not.toContain("ClaimableRecorded");
    expect(eventNames(tokenMediatorAbi)).not.toContain("Claimed");
  });
  it("BeaconLightClient, BeaconForkGate and ForkRegistry", () => {
    expect(eventNames(beaconLightClientAbi)).toContain("HeadUpdated");
    expect(eventNames(beaconForkGateAbi)).toEqual(
      expect.arrayContaining(["ForkConfirmed", "GateSealedByFork", "BeaconRootsDetected", "ExecutionCanaryFired"]),
    );
    expect(eventNames(forkRegistryAbi)).toContain("ForkObserved");
  });
  it("the standalone Transfer event has the topic of the ERC-20 event in BridgedToken", () => {
    const erc20 = bridgedTokenAbi.find((item) => item.type === "event" && item.name === "Transfer" && item.inputs.length === 3);
    expect(erc20).toBeDefined();
    const standalone = getAbiItem({ abi: bridgedTokenTransferAbi, name: "Transfer" });
    expect(toEventSelector(standalone)).toBe(toEventSelector(erc20 as never));
  });
});
