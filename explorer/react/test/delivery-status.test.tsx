import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MESSAGE_STATUSES } from "@zkb/data";
import { NEEDS_YOU_AFTER_SECONDS, groupOf, positionOf, stepOf, stepWords, useDeliveryStatus } from "../src/index.js";

const NOW = 1_800_000_000;

describe("the steps and the pulse", () => {
  it("put every status on a step and a position", () => {
    expect(MESSAGE_STATUSES.map(stepOf)).toEqual([0, 1, 2, 5, 2, 2]);
    expect(MESSAGE_STATUSES.map(positionOf)).toEqual([0.18, 0.42, 0.72, 1, 0.72, 0.72]);
  });
});

describe("stepWords", () => {
  const words = (status: (typeof MESSAGE_STATUSES)[number], waitedSeconds = 0) => stepWords({ status, sentAt: NOW - waitedSeconds, destinationName: "PulseChain", now: NOW });

  it("says each step", () => {
    expect(words("sent")).toBe("Sent · waiting for finality");
    expect(words("waiting_for_finality")).toBe("Final soon · waiting for the proof");
    expect(words("delivered")).toBe("Delivered to PulseChain");
    expect(words("failed_call")).toBe("Delivered, but the call after it failed");
    expect(words("release_failed")).toBe("The release failed");
  });

  it("says how long a proven transfer has waited, in minutes, hours or days", () => {
    expect(words("covered")).toBe("Proven · waiting for a deliverer");
    expect(words("covered", 10 * 60)).toBe("Proven · waiting for a deliverer for 10 min");
    expect(words("covered", 3 * 3600)).toBe("Proven · waiting for a deliverer for 3 h");
    expect(words("covered", 3 * 86_400)).toBe("Proven · waiting for a deliverer for 3 days");
    // A clock behind the send time never reads as a negative wait.
    expect(stepWords({ status: "covered", sentAt: NOW + 500, destinationName: "x", now: NOW })).toBe("Proven · waiting for a deliverer");
  });
});

describe("groupOf", () => {
  it("is delivered, needs you (a failure, or proven and undelivered for 30 minutes), or in flight", () => {
    expect(groupOf("delivered", NOW, NOW)).toBe("delivered");
    expect(groupOf("failed_call", NOW, NOW)).toBe("needs-you");
    expect(groupOf("release_failed", NOW, NOW)).toBe("needs-you");
    expect(groupOf("covered", NOW - NEEDS_YOU_AFTER_SECONDS, NOW)).toBe("in-flight");
    expect(groupOf("covered", NOW - NEEDS_YOU_AFTER_SECONDS - 1, NOW)).toBe("needs-you");
    expect(groupOf("sent", NOW - 99_999, NOW)).toBe("in-flight");
  });
});

describe("useDeliveryStatus", () => {
  it("gives the group, the step, the position and the words of a transfer", () => {
    const { result } = renderHook(() => useDeliveryStatus({ status: "covered", sentAt: NOW - 40 * 60, destinationName: "Ethereum", now: NOW }));
    expect(result.current).toEqual({ group: "needs-you", step: 2, position: 0.72, words: "Proven · waiting for a deliverer for 40 min" });
  });
});
