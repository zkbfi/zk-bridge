import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countParticipants, participantsOfBlock, readingFromFinalityUpdate, slotOfHeadEvent, slotOfHeader } from "../src/watch/beacon.ts";
import { createSseParser, EventStreamError, readEventStream, type ServerSentEvent } from "../src/watch/sse.ts";
import { bits, block, fakeBeacon, finalityUpdate, flush, header } from "./watch-support.ts";

describe("createSseParser", () => {
  it("reads named events, joins data lines, and skips comments and other fields", () => {
    const events: ServerSentEvent[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.push(": keep-alive\n\nevent: head\ndata: {\"slot\":\"1\"}\nid: 7\n\n");
    parser.push("data: a\ndata: b\n\n");
    parser.push("data\n\nevent: empty\n\n");
    expect(events).toEqual([
      { event: "head", data: '{"slot":"1"}' },
      { event: "message", data: "a\nb" },
      { event: "message", data: "" },
    ]);
  });

  it("takes text in any pieces and any line ending", () => {
    const events: ServerSentEvent[] = [];
    const parser = createSseParser((event) => events.push(event));
    for (const piece of ["event: fin", "alized_checkpoint\r", "\ndata: x\r\n", "\r", "\revent: head\rdata:y\r\r"]) parser.push(piece);
    // The last `\r` may still become `\r\n`: the event ends with the next piece.
    expect(events).toHaveLength(1);
    parser.push("\n");
    expect(events).toEqual([
      { event: "finalized_checkpoint", data: "x" },
      { event: "head", data: "y" },
    ]);
  });
});

describe("the beacon parsers", () => {
  it("counts the participants of sync_committee_bits", () => {
    expect(countParticipants(bits(0))).toBe(0);
    expect(countParticipants(bits(342))).toBe(342);
    expect(countParticipants(bits(512))).toBe(512);
    expect(countParticipants("0x00")).toBeNull();
    expect(countParticipants(42)).toBeNull();
  });

  it("reads a finality update in the served shape, the bare shape, or not at all", () => {
    expect(readingFromFinalityUpdate(finalityUpdate(320, 400, 386))).toEqual({ finalizedSlot: 320, signatureSlot: 386, participants: 400 });
    expect(readingFromFinalityUpdate(finalityUpdate(320, 400).data)).toMatchObject({ finalizedSlot: 320 });
    expect(readingFromFinalityUpdate({ data: { finalized_header: { beacon: { slot: "7" } } } })).toEqual({ finalizedSlot: 7, signatureSlot: null, participants: null });
    expect(readingFromFinalityUpdate({ data: { finalized_header: { beacon: { slot: 7 } } } })).toBeNull();
    expect(readingFromFinalityUpdate(null)).toBeNull();
    expect(readingFromFinalityUpdate({ data: { finalized_header: { beacon: { slot: "99999999999999999999" } } } })).toBeNull();
  });

  it("reads header slots, block participation and head events", () => {
    expect(slotOfHeader(header(12))).toBe(12);
    expect(slotOfHeader({})).toBeNull();
    expect(participantsOfBlock(block(500))).toBe(500);
    expect(participantsOfBlock({ data: {} })).toBeNull();
    expect(slotOfHeadEvent({ slot: "9" })).toBe(9);
    expect(slotOfHeadEvent("nope")).toBeNull();
  });
});

describe("readEventStream", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function open(beacon: ReturnType<typeof fakeBeacon>, signal = new AbortController().signal) {
    const events: ServerSentEvent[] = [];
    let opened = 0;
    const done = readEventStream({
      url: `${beacon.base}/eth/v1/events?topics=head`,
      fetchFunction: beacon.fetchFunction,
      openTimeoutMilliseconds: 10_000,
      idleMilliseconds: 41_000,
      signal,
      onOpen: () => (opened += 1),
      onEvent: (event) => events.push(event),
    });
    return { events, done, opened: () => opened };
  }

  it("delivers events until the node closes the stream", async () => {
    const beacon = fakeBeacon();
    const stream = open(beacon);
    await flush();
    expect(stream.opened()).toBe(1);
    beacon.latest().send("head", { slot: "5" });
    await flush();
    expect(stream.events).toEqual([{ event: "head", data: '{"slot":"5"}' }]);
    beacon.latest().close();
    await expect(stream.done).resolves.toBeUndefined();
  });

  it("fails with the status when the node refuses, and when it answers no event stream", async () => {
    const beacon = fakeBeacon();
    beacon.streamAnswers({ status: 400 });
    await expect(open(beacon).done).rejects.toMatchObject({ name: "EventStreamError", status: 400, message: "the beacon node answered 400" });
    beacon.streamAnswers("html");
    await expect(open(beacon).done).rejects.toMatchObject({ status: 200, message: "the beacon node did not answer an event stream" });
    beacon.streamAnswers({ status: 200 });
    await expect(open(beacon).done).rejects.toMatchObject({ status: 200, message: "the beacon node did not answer an event stream" });
  });

  it("fails when the node sends no headers in time (a proxy that holds the stream)", async () => {
    const beacon = fakeBeacon();
    beacon.streamAnswers("hang");
    const stream = open(beacon);
    const failure = expect(stream.done).rejects.toEqual(new EventStreamError("no answer within 10 s", null));
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
  });

  it("fails when the stream goes silent, and an event resets the wait", async () => {
    const beacon = fakeBeacon();
    const stream = open(beacon);
    await flush();
    await vi.advanceTimersByTimeAsync(40_000);
    beacon.latest().send("head", { slot: "6" });
    await flush();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(beacon.latest().closed).toBe(false);
    const failure = expect(stream.done).rejects.toEqual(new EventStreamError("no event for 41 s", 200));
    await vi.advanceTimersByTimeAsync(1_000);
    await failure;
  });

  it("ends quietly when the caller aborts", async () => {
    const beacon = fakeBeacon();
    const controller = new AbortController();
    const stream = open(beacon, controller.signal);
    await flush();
    controller.abort();
    await expect(stream.done).resolves.toBeUndefined();
  });

  it("passes other errors through", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(
      readEventStream({ url: "http://x.test/", fetchFunction: failing, openTimeoutMilliseconds: 1, idleMilliseconds: 1, signal: new AbortController().signal, onOpen: () => {}, onEvent: () => {} }),
    ).rejects.toThrow("fetch failed");
  });
});
