import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJsonGet } from "../src/keepalive/sources.ts";
import { MIN_PARTICIPANTS } from "../src/watch/decide.ts";
import { createFinalityFeed, type FinalityObservation } from "../src/watch/feed.ts";
import { memoryLogger } from "./support.ts";
import { block, fakeBeacon, finalityUpdate, flush, header } from "./watch-support.ts";

const FINALITY = "/eth/v1/beacon/light_client/finality_update";
const SLOT_MS = 12_000;

function startFeed(beacon: ReturnType<typeof fakeBeacon>, options: { sse?: boolean } = {}) {
  const observations: FinalityObservation[] = [];
  const log = memoryLogger();
  const feed = createFinalityFeed({
    chainId: 11155111,
    beaconUrl: `${beacon.base}/`,
    minParticipants: MIN_PARTICIPANTS,
    sse: options.sse ?? true,
    pollMilliseconds: SLOT_MS,
    sseOpenTimeoutMilliseconds: 10_000,
    sseIdleMilliseconds: 3 * SLOT_MS + 5_000,
    sseRetryMilliseconds: { initial: 5_000, max: 20_000 },
    get: fetchJsonGet(beacon.fetchFunction),
    fetchFunction: () => beacon.fetchFunction,
    logger: log.logger,
    now: Date.now,
    onObservation: (observation) => observations.push(observation),
  });
  feed.start();
  const events = () => log.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { feed, observations, events, named: (name: string) => events().filter((event) => event.event === name) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(1_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the finality feed, light-client mode", () => {
  it("reads the update at start, then takes each new update from the event stream at once", async () => {
    const beacon = fakeBeacon();
    beacon.set(FINALITY, finalityUpdate(320, 500));
    const run = startFeed(beacon);
    await flush();
    expect(run.observations).toEqual([{ finalizedSlot: 320, signatureSlot: 385, participants: 500, source: "poll", receivedAt: 1_000_000_000 }]);
    expect(run.feed.state()).toEqual({ transport: "sse", mode: "light-client" });
    expect(beacon.latest().topics).toBe("head,finalized_checkpoint,light_client_finality_update");
    expect(run.named("watch_transport")).toMatchObject([{ chainId: 11155111, transport: "sse", mode: "light-client" }]);

    vi.setSystemTime(1_000_005_000);
    beacon.latest().send("light_client_finality_update", finalityUpdate(352, 480));
    await flush();
    expect(run.observations[1]).toEqual({ finalizedSlot: 352, signatureSlot: 417, participants: 480, source: "sse", receivedAt: 1_000_005_000 });

    // The same update again, or an older one, is no news; more signatures over the same header are.
    beacon.latest().send("light_client_finality_update", finalityUpdate(352, 480));
    beacon.latest().send("light_client_finality_update", finalityUpdate(320, 512));
    // Head events carry nothing while the update topic runs: no read.
    const reads = beacon.requests.length;
    beacon.latest().send("head", { slot: "420" });
    await flush();
    expect(beacon.requests.length).toBe(reads);
    beacon.latest().send("light_client_finality_update", finalityUpdate(352, 500));
    await flush();
    // An update without readable bits counts as no signers, and any count beats it.
    const unreadable = finalityUpdate(384, 0);
    unreadable.data.sync_aggregate.sync_committee_bits = "0x";
    beacon.latest().send("light_client_finality_update", unreadable);
    beacon.latest().send("light_client_finality_update", unreadable);
    beacon.latest().send("light_client_finality_update", finalityUpdate(384, 1));
    await flush();
    expect(run.observations.map((observation) => [observation.finalizedSlot, observation.participants])).toEqual([[320, 500], [352, 480], [352, 500], [384, null], [384, 1]]);
    await run.feed.stop();
  });

  it("reads the update on a finalized_checkpoint event and ignores events it does not know", async () => {
    const beacon = fakeBeacon();
    beacon.set(FINALITY, finalityUpdate(320, 500));
    const run = startFeed(beacon);
    await flush();
    beacon.set(FINALITY, finalityUpdate(352, 500));
    beacon.latest().send("finalized_checkpoint", { epoch: "11" });
    beacon.latest().send("chain_reorg", {});
    await flush();
    expect(run.observations.map((observation) => [observation.finalizedSlot, observation.source])).toEqual([[320, "poll"], [352, "sse"]]);
    await run.feed.stop();
  });

  it("subscribes without the update topic when the node refuses it, and reads on each head event", async () => {
    const beacon = fakeBeacon();
    beacon.set(FINALITY, finalityUpdate(320, 500));
    beacon.streamAnswers({ status: 400 });
    const run = startFeed(beacon);
    await flush();
    // The refusal of the topic retries at once without it; that one fails too and the poll takes over.
    expect(run.named("watch_sse_topic_refused")).toMatchObject([{ topic: "light_client_finality_update" }]);
    expect(run.named("watch_sse_failed")).toHaveLength(1);
    beacon.streamAnswers("open");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(beacon.latest().topics).toBe("head,finalized_checkpoint");
    beacon.set(FINALITY, finalityUpdate(352, 500));
    beacon.latest().send("head", { slot: "420" });
    await flush();
    expect(run.observations.at(-1)).toMatchObject({ finalizedSlot: 352, source: "sse" });
    await run.feed.stop();
  });

  it("logs a broken update once, and the recovery once", async () => {
    const beacon = fakeBeacon();
    beacon.set(FINALITY, { data: { nothing: true } });
    const run = startFeed(beacon, { sse: false });
    await flush();
    await vi.advanceTimersByTimeAsync(SLOT_MS * 2);
    beacon.set(FINALITY, {}, 503);
    await vi.advanceTimersByTimeAsync(SLOT_MS);
    expect(run.named("watch_beacon_read_failed")).toHaveLength(1);
    expect(run.named("watch_beacon_read_failed")[0]).toMatchObject({ error: { message: "the beacon node sent a finality update in an unknown shape" } });
    beacon.set(FINALITY, finalityUpdate(320, 500));
    await vi.advanceTimersByTimeAsync(SLOT_MS);
    expect(run.named("watch_beacon_recovered")).toHaveLength(1);
    expect(run.observations).toHaveLength(1);
    beacon.set(FINALITY, {}, 503);
    await vi.advanceTimersByTimeAsync(SLOT_MS);
    expect(run.named("watch_beacon_read_failed")[1]).toMatchObject({ error: { message: "the beacon node answered 503 for the finality update" } });
    await run.feed.stop();
  });

  it("an event that is not JSON is read as nothing", async () => {
    const beacon = fakeBeacon();
    beacon.set(FINALITY, finalityUpdate(320, 500));
    const run = startFeed(beacon);
    await flush();
    beacon.latest().sendRaw("event: light_client_finality_update\ndata: {broken\n\n");
    await flush();
    expect(run.named("watch_beacon_read_failed")).toHaveLength(1);
    await run.feed.stop();
  });
});

describe("the finality feed, falling back to the poll", () => {
  it.each([404, 405, 501])("takes a %i as a node that does not serve the stream: one info line, the poll, and a new try only after an hour", async (status) => {
    const beacon = fakeBeacon();
    beacon.set(FINALITY, finalityUpdate(320, 500));
    beacon.streamAnswers({ status });
    const run = startFeed(beacon);
    await flush();
    expect(run.feed.state().transport).toBe("poll");
    expect(run.named("watch_sse_failed")).toHaveLength(0);
    expect(run.named("watch_sse_unsupported")).toMatchObject([{ chainId: 11155111, status, retryInSeconds: 3600 }]);
    beacon.set(FINALITY, finalityUpdate(352, 500));
    await vi.advanceTimersByTimeAsync(SLOT_MS);
    expect(run.observations.at(-1)).toMatchObject({ finalizedSlot: 352, source: "poll" });
    const tries = () => beacon.requests.filter((path) => path.startsWith("/eth/v1/events")).length;
    const before = tries();
    // The hour counts from the refusal at the start; one slot of it has passed.
    await vi.advanceTimersByTimeAsync(3_600_000 - SLOT_MS - 1_000);
    expect(tries()).toBe(before);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tries()).toBe(before + 1);
    // The node still refuses: no second line, the wait stays an hour.
    expect(run.named("watch_sse_unsupported")).toHaveLength(1);
    expect(run.named("watch_sse_failed")).toHaveLength(0);
    beacon.streamAnswers("open");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(run.feed.state().transport).toBe("sse");
  });

  it("polls every slot while the node refuses the stream, and tries the stream again with a growing wait", async () => {
    const beacon = fakeBeacon();
    beacon.set(FINALITY, finalityUpdate(320, 500));
    beacon.streamAnswers({ status: 503 });
    const run = startFeed(beacon);
    await flush();
    expect(run.feed.state().transport).toBe("poll");
    expect(run.named("watch_sse_failed")).toMatchObject([{ chainId: 11155111, retryInSeconds: 5, error: { message: "the beacon node answered 503" } }]);
    beacon.set(FINALITY, finalityUpdate(352, 500));
    await vi.advanceTimersByTimeAsync(SLOT_MS);
    expect(run.observations.at(-1)).toMatchObject({ finalizedSlot: 352, source: "poll" });
    await vi.advanceTimersByTimeAsync(20_000);
    // Tries after 5 s, 10 s, then 20 s (the longest wait).
    expect(run.named("watch_sse_failed").map((event) => event.retryInSeconds)).toEqual([5, 10, 20]);
    beacon.streamAnswers("open");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run.feed.state().transport).toBe("sse");
    // While the stream runs the poll stays quiet.
    const reads = beacon.requests.filter((path) => path === FINALITY).length;
    await vi.advanceTimersByTimeAsync(SLOT_MS);
    beacon.latest().send("head", { slot: "500" });
    await flush();
    expect(beacon.requests.filter((path) => path === FINALITY).length).toBe(reads);
    await run.feed.stop();
  });

  it("falls back when the node holds the stream's headers, and when an open stream goes silent or closes", async () => {
    const beacon = fakeBeacon();
    beacon.set(FINALITY, finalityUpdate(320, 500));
    beacon.streamAnswers("hang");
    const run = startFeed(beacon);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.named("watch_sse_failed")[0]).toMatchObject({ error: { message: "no answer within 10 s" } });
    beacon.streamAnswers("open");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run.feed.state().transport).toBe("sse");
    await vi.advanceTimersByTimeAsync(3 * SLOT_MS + 5_000);
    expect(run.named("watch_sse_failed")[1]).toMatchObject({ error: { message: "no event for 41 s" }, retryInSeconds: 5 });
    expect(run.feed.state().transport).toBe("poll");
    await vi.advanceTimersByTimeAsync(5_000);
    beacon.latest().close();
    await flush();
    expect(run.named("watch_sse_failed")[2]).toMatchObject({ error: { message: "the beacon node closed the stream" } });
    await run.feed.stop();
  });

  it("only polls when the stream is switched off", async () => {
    const beacon = fakeBeacon();
    beacon.set(FINALITY, finalityUpdate(320, 500));
    const run = startFeed(beacon, { sse: false });
    await flush();
    expect(run.feed.state()).toEqual({ transport: "poll", mode: "light-client" });
    expect(beacon.streams).toHaveLength(0);
    await run.feed.stop();
    // A stopped feed reads nothing more.
    const reads = beacon.requests.length;
    await vi.advanceTimersByTimeAsync(SLOT_MS * 3);
    expect(beacon.requests.length).toBe(reads);
  });
});

describe("the finality feed, blocks mode", () => {
  function blocksBeacon() {
    const beacon = fakeBeacon();
    beacon.set(FINALITY, { message: "not served" }, 404);
    beacon.set("/eth/v1/beacon/headers/finalized", header(320));
    beacon.set("/eth/v1/beacon/headers/head", header(410));
    return beacon;
  }

  it("reports a new finalized slot once a later block signs it, with that block's participation", async () => {
    const beacon = blocksBeacon();
    const run = startFeed(beacon);
    await flush();
    expect(run.feed.state()).toEqual({ transport: "sse", mode: "blocks" });
    expect(beacon.latest().topics).toBe("head,finalized_checkpoint");
    expect(run.observations).toEqual([]);
    beacon.set("/eth/v2/beacon/blocks/411", block(400));
    vi.setSystemTime(1_000_002_000);
    beacon.latest().send("head", { slot: "411" });
    await flush();
    expect(run.observations).toEqual([{ finalizedSlot: 320, signatureSlot: 411, participants: 400, source: "sse", receivedAt: 1_000_002_000 }]);
    // Nothing new until the finalized slot moves.
    beacon.latest().send("head", { slot: "412" });
    await flush();
    expect(run.observations).toHaveLength(1);
    beacon.set("/eth/v1/beacon/headers/finalized", header(352));
    beacon.latest().send("finalized_checkpoint", { epoch: "11" });
    await flush();
    expect(run.observations).toHaveLength(1);
    beacon.set("/eth/v2/beacon/blocks/449", block(100));
    beacon.latest().send("head", { slot: "449" });
    await flush();
    // Too few signers: the next block is read too.
    beacon.set("/eth/v2/beacon/blocks/450", block(450));
    beacon.latest().send("head", { slot: "450" });
    await flush();
    expect(run.observations.map((observation) => [observation.finalizedSlot, observation.signatureSlot, observation.participants])).toEqual([
      [320, 411, 400],
      [352, 449, 100],
      [352, 450, 450],
    ]);
    beacon.latest().send("head", { slot: "451" });
    await flush();
    expect(run.observations).toHaveLength(3);
    await run.feed.stop();
  });

  it("switches to blocks mode when a light-client node stops serving updates, and subscribes again", async () => {
    const beacon = fakeBeacon();
    beacon.set(FINALITY, finalityUpdate(320, 500));
    beacon.set("/eth/v1/beacon/headers/finalized", header(352));
    beacon.set("/eth/v1/beacon/headers/head", header(420));
    const run = startFeed(beacon, { sse: true });
    await flush();
    expect(beacon.latest().topics).toContain("light_client_finality_update");
    beacon.set(FINALITY, {}, 501);
    beacon.latest().send("finalized_checkpoint", {});
    await flush();
    expect(run.feed.state().mode).toBe("blocks");
    expect(beacon.latest().topics).toBe("head,finalized_checkpoint");
    beacon.set("/eth/v2/beacon/blocks/421", block(512));
    beacon.latest().send("head", { slot: "421" });
    await flush();
    expect(run.observations.at(-1)).toMatchObject({ finalizedSlot: 352, signatureSlot: 421, participants: 512 });
    await run.feed.stop();
  });

  it("polls the head when no event names it, and reports a missing block or header as a failed read", async () => {
    const beacon = blocksBeacon();
    const run = startFeed(beacon, { sse: false });
    await flush();
    beacon.set("/eth/v1/beacon/headers/head", header(411));
    await vi.advanceTimersByTimeAsync(SLOT_MS);
    expect(run.named("watch_beacon_read_failed")[0]).toMatchObject({ error: { message: "the beacon node answered 404 for block 411" } });
    beacon.set("/eth/v1/beacon/headers/head", {}, 500);
    beacon.set("/eth/v1/beacon/headers/finalized", {}, 500);
    await vi.advanceTimersByTimeAsync(SLOT_MS);
    beacon.set("/eth/v1/beacon/headers/finalized", header(320));
    beacon.set("/eth/v1/beacon/headers/head", header(412));
    beacon.set("/eth/v2/beacon/blocks/412", block(500));
    await vi.advanceTimersByTimeAsync(SLOT_MS);
    expect(run.observations).toEqual([{ finalizedSlot: 320, signatureSlot: 412, participants: 500, source: "poll", receivedAt: Date.now() }]);
    await run.feed.stop();
  });

  it("a head event without a slot reads the head header", async () => {
    const beacon = blocksBeacon();
    const run = startFeed(beacon);
    await flush();
    beacon.set("/eth/v1/beacon/headers/head", header(411));
    beacon.set("/eth/v2/beacon/blocks/411", block(500));
    beacon.latest().send("head", {});
    await flush();
    expect(run.observations).toHaveLength(1);
    await run.feed.stop();
  });
});

describe("the finality feed, triggers that overlap", () => {
  it("runs one read at a time and keeps only the newest trigger that arrived meanwhile", async () => {
    const beacon = fakeBeacon();
    beacon.set(FINALITY, finalityUpdate(320, 500));
    const run = startFeed(beacon);
    await flush();
    const reads = () => beacon.requests.filter((path) => path === FINALITY).length;
    const before = reads();
    // Three events in one piece: the first reads, the third waits for it, the second is dropped.
    beacon.set(FINALITY, finalityUpdate(352, 500));
    beacon.latest().sendRaw("event: finalized_checkpoint\ndata: {}\n\n".repeat(3));
    await flush();
    expect(reads() - before).toBe(2);
    expect(run.observations.map((observation) => observation.finalizedSlot)).toEqual([320, 352]);
    await run.feed.stop();
  });
});
