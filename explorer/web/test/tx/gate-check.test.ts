// The confirm(evidence) step as the web confirm dialog shows it. The step itself lives in @terminal/tx/gate-step.
import { getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { GateEvidenceError, type GateConfirmation } from "@zk-bridge/shared";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { buildConfirmView } from "../../src/tx/confirm-model";
import { gateErrorText, passesGate, planGateConfirm } from "@terminal/tx/gate-step";
import { encodeFunctionData, parseAbi } from "viem";

describe("the confirmation step", () => {
  const evidence: Hex = `0x${"ab".repeat(40)}`;
  const gate = FIXTURE_PAIR.first.contracts.gate as Address;
  const answer = {
    kind: "confirm",
    call: { to: gate, data: encodeFunctionData({ abi: parseAbi(["function confirm(bytes evidence)"]), functionName: "confirm", args: [evidence] }) },
    gas: 150_000n,
    epoch: 360_335n,
    forkVersion: "0x90000075",
    shape: 6,
    validUntil: 1_762_502_400n,
    evidence: { encoded: evidence, header: { slot: 11_530_720n } },
  } as unknown as Extract<GateConfirmation, { kind: "confirm" }>;

  it("is confirm(bytes) on the gate with no value, and says the epoch and the deadline in numbers", () => {
    const plan = planGateConfirm(FIXTURE_PAIR.first, answer);
    expect(plan).toMatchObject({ title: "Confirm this epoch on the gate (epoch 360335)", to: getAddress(gate), functionSignature: "confirm(bytes)", value: 0n });
    expect(plan.notes).toEqual([
      "The Ethereum deposit gate admits sends in epoch 360335 once one transaction confirms it. This transaction confirms it. Your send follows as the next step.",
      "The evidence proves fork version 0x90000075 with the beacon header of slot 11530720. The gate checks it against the beacon root on chain.",
      "It must be mined before 08:00:00 UTC, the end of epoch 360335. It sends no ETH.",
    ]);
  });

  it("passes the confirm dialog's check of the bytes", () => {
    const plan = planGateConfirm(FIXTURE_PAIR.first, answer);
    const view = buildConfirmView({ plan, disclosure: { feesApplyTo: "this-transaction", destinationNativeSymbol: null, destinationChainId: null, amountToken: null, delivery: null } });
    expect(view.blockedReason).toBeNull();
    expect(view.noRouterNotice).toBeNull();
    expect(view.arguments[0]).toMatchObject({ name: "evidence", meaning: "40 bytes" });
    expect(view.notes).toHaveLength(3);
  });
});

describe("passesGate and gateErrorText", () => {
  it("counts the sends on a chain with a gate only", () => {
    const plan = planGateConfirm(FIXTURE_PAIR.first, { call: { to: FIXTURE_PAIR.first.contracts.gate as Address, data: "0x" }, epoch: 1n, forkVersion: "0x00", validUntil: 0n, evidence: { encoded: "0x", header: { slot: 0n } } } as never);
    expect(passesGate(plan)).toBe(false);
    expect(passesGate({ ...plan, functionName: "relayTokens" })).toBe(true);
    expect(passesGate({ ...plan, functionName: "relayTokens", chain: { ...plan.chain, contracts: { ...plan.chain.contracts, gate: null } } })).toBe(false);
  });

  it("writes a thrown value that is not an Error as text", () => {
    expect(gateErrorText("odd", "Sepolia")).toBe("Could not confirm the Sepolia deposit gate: odd.");
    expect(gateErrorText(new GateEvidenceError("beacon-request-failed", "no beacon endpoint answered"), "Sepolia", "Check Settings.")).toBe(
      "Could not confirm the Sepolia deposit gate: no beacon endpoint answered. Check Settings.",
    );
  });
});
