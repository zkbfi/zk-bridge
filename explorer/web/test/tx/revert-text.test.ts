import { encodeAbiParameters, encodeErrorResult, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { beaconForkGateAbi, bridgedTokenAbi, messageBridgeAbi } from "@zk-bridge/shared";
import { BRIDGE_ERROR_ABI, decodeRevert, isForkNotConfirmed, revertDataOf, revertText } from "../../src/tx/revert-text";

const SEPOLIA = { chainName: "Sepolia" };

/** A viem-like error with the revert data a few causes down, as an estimate failure carries it. */
const reverted = (data: Hex, shape: "flat" | "nested" = "flat"): Error =>
  Object.assign(new Error("Execution reverted for an unknown reason."), {
    cause: Object.assign(new Error("execution reverted"), { cause: shape === "flat" ? { data } : { data: { data } } }),
  });

describe("revert text", () => {
  it("turns the user's revert, ForkNotConfirmed(360335) of the Sepolia gate, into plain text", () => {
    const data = encodeErrorResult({ abi: beaconForkGateAbi, errorName: "ForkNotConfirmed", args: [360_335n] });
    expect(data.slice(0, 10)).toBe("0xe58a03ef");
    expect(revertText(reverted(data), SEPOLIA)).toBe("The Sepolia deposit gate needs epoch 360335 confirmed first. A send in this epoch reverts until one transaction confirms it.");
    expect(isForkNotConfirmed(reverted(data))).toBe(true);
  });

  it("names a sealed gate and a confirmation of a past epoch", () => {
    expect(revertText(reverted(encodeErrorResult({ abi: beaconForkGateAbi, errorName: "GateSealed" })), SEPOLIA)).toBe("The Sepolia deposit gate is sealed. It admits no send.");
    expect(revertText(reverted(encodeErrorResult({ abi: beaconForkGateAbi, errorName: "HeaderNotInCurrentEpoch", args: [4n, 5n] })), SEPOLIA)).toBe(
      "The confirmation names a beacon header of epoch 4, and the chain is in epoch 5 now. A new confirmation is needed.",
    );
  });

  it("names any other bridge error with its arguments, from the data nested in an RPC error", () => {
    const data = encodeErrorResult({ abi: bridgedTokenAbi, errorName: "ERC20InsufficientBalance", args: ["0x8D43a3DF4951652d04bA29098D292136Af004Bdd", 1n, 2n] });
    expect(revertText(reverted(data, "nested"), SEPOLIA)).toBe("The contract reverted with ERC20InsufficientBalance (sender 0x8D43a3DF4951652d04bA29098D292136Af004Bdd, balance 1, needed 2).");
    expect(revertText(reverted(encodeErrorResult({ abi: messageBridgeAbi, errorName: "DepositsNotOpen" })), SEPOLIA)).toBe("The contract reverted with DepositsNotOpen.");
    expect(isForkNotConfirmed(reverted(data))).toBe(false);
  });

  it("reads Error(string) and Panic(uint256)", () => {
    const message = `0x08c379a0${encodeAbiParameters([{ type: "string" }], ["not enough"]).slice(2)}` as Hex;
    expect(revertText(reverted(message), SEPOLIA)).toBe("The contract reverted: not enough.");
    const panic = `0x4e487b71${encodeAbiParameters([{ type: "uint256" }], [0x11n]).slice(2)}` as Hex;
    expect(revertText(reverted(panic), SEPOLIA)).toBe("The contract stopped with panic code 0x11.");
  });

  it("names the selector of an error that no bridge contract defines, and gives null with no revert data", () => {
    expect(revertText(reverted("0xdeadbeef"), SEPOLIA)).toBe("The contract reverted with the error 0xdeadbeef, which no bridge contract defines.");
    expect(revertText(new Error("fetch failed"), SEPOLIA)).toBeNull();
    expect(revertText("a string", SEPOLIA)).toBeNull();
    expect(revertDataOf({ data: "0x12" })).toBeNull();
    expect(revertDataOf(null)).toBeNull();
    expect(decodeRevert(new Error("none"))).toBeNull();
  });

  it("holds each bridge error once", () => {
    const names = BRIDGE_ERROR_ABI.map((item) => (item.type === "error" ? item.name : ""));
    expect(names.filter((name) => name === "ZeroValue")).toHaveLength(1);
    expect(names).toContain("ForkNotConfirmed");
    expect(names).toContain("DeliveryInProgress");
  });
});
