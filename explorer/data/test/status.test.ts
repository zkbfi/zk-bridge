import { describe, expect, it } from "vitest";
import { MESSAGE_STATUSES, deriveStatus, isCovered, isInFlight, defaultFinalitySeconds, secondsPerSlot, type StatusFacts } from "../src/status.js";

const base: StatusFacts = {
  delivery: "none",
  releaseFailed: false,
  coveredByHead: false,
  sentTimestamp: 1000n,
  latestSourceTimestamp: 1000n,
  finalitySeconds: 768,
};
const facts = (patch: Partial<StatusFacts>): StatusFacts => ({ ...base, ...patch });

describe("deriveStatus", () => {
  it("is sent while the send is younger than the finality window", () => {
    expect(deriveStatus(facts({ latestSourceTimestamp: 1767n }))).toBe("sent");
  });
  it("waits for finality at exactly the window", () => {
    expect(deriveStatus(facts({ latestSourceTimestamp: 1768n }))).toBe("waiting_for_finality");
  });
  it("is covered as soon as a stored head covers the block, even inside the window", () => {
    expect(deriveStatus(facts({ coveredByHead: true }))).toBe("covered");
  });
  it("is delivered after a successful call", () => {
    expect(deriveStatus(facts({ delivery: "succeeded", coveredByHead: true }))).toBe("delivered");
  });
  it("delivery wins even when the covering head arrived after the delivery in indexing order", () => {
    expect(deriveStatus(facts({ delivery: "succeeded", coveredByHead: false }))).toBe("delivered");
  });
  it("has no failed_call status: a delivery that fails reverts and leaves the message undelivered", () => {
    expect(MESSAGE_STATUSES).not.toContain("failed_call");
    expect(deriveStatus(facts({ delivery: "none", coveredByHead: true }))).toBe("covered");
  });
  it("has no fallback_used status: the mediator pays only the recipient", () => {
    expect(MESSAGE_STATUSES).not.toContain("fallback_used");
  });
  it("is release_failed when the recipient could not take the release, and the failure is final", () => {
    expect(deriveStatus(facts({ delivery: "succeeded", releaseFailed: true }))).toBe("release_failed");
    expect(deriveStatus(facts({ delivery: "succeeded", releaseFailed: false }))).toBe("delivered");
  });
  it("has no claimable status: the mediator keeps no claim records", () => {
    expect(MESSAGE_STATUSES).not.toContain("claimable");
  });
});

describe("coverage rule", () => {
  it("covers when the head execution block equals or passes the source block", () => {
    expect(isCovered(100n, 100n)).toBe(true);
    expect(isCovered(101n, 100n)).toBe(true);
  });
  it("does not cover an earlier head or no head", () => {
    expect(isCovered(99n, 100n)).toBe(false);
    expect(isCovered(null, 100n)).toBe(false);
  });
});

describe("helpers", () => {
  it("counts the first three statuses as in flight", () => {
    expect(["sent", "waiting_for_finality", "covered"].every((status) => isInFlight(status as never))).toBe(true);
    expect(isInFlight("delivered")).toBe(false);
  });
  it("uses two epochs of the source chain as the default finality window", () => {
    expect(defaultFinalitySeconds(1)).toBe(768);
    expect(defaultFinalitySeconds(369)).toBe(640);
  });
  it("gives each testnet the window of the network family that it copies: Sepolia like Ethereum, chain 943 like PulseChain", () => {
    expect(defaultFinalitySeconds(11155111)).toBe(12 * 32 * 2);
    expect(defaultFinalitySeconds(943)).toBe(10 * 32 * 2);
    expect(defaultFinalitySeconds(11155111)).toBe(defaultFinalitySeconds(1));
    expect(defaultFinalitySeconds(943)).toBe(defaultFinalitySeconds(369));
  });
  it("reads the slot length from the table and falls back to 12 seconds for a chain that has no entry", () => {
    expect([1, 369, 11155111, 943].map(secondsPerSlot)).toEqual([12, 10, 12, 10]);
    expect(secondsPerSlot(5)).toBe(12);
    expect(defaultFinalitySeconds(5)).toBe(768);
  });
});
