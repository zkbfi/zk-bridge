/**
 * The finality feed of one source beacon node: it learns of each new finalized header within seconds and reports it
 * with the participation of the signatures over it.
 *
 * Transport: the event stream `/eth/v1/events` when the node serves it, else a poll every slot. A stream that fails to
 * open, closes or goes silent switches to the poll at once and is tried again with a growing wait.
 *
 * Mode, chosen by asking `/eth/v1/beacon/light_client/finality_update` once:
 *
 * - `light-client`: the node serves light-client updates. The reading is that update: the same one the prover takes,
 *   so the finalized header and the signatures are exactly what the proof will carry.
 * - `blocks`: the node answers 404 or 501 (the PulseChain nodes). The prover then builds the update from the newest
 *   block that has a child, signed by the child's sync aggregate. So a new finalized slot is reported once a block
 *   after the one that showed it exists, with that block's participation; a block with too few signers is followed by
 *   the next one.
 */
import type { JsonGet } from "../keepalive/sources.ts";
import type { Logger } from "../logger.ts";
import { participantsOfBlock, readingFromFinalityUpdate, slotOfHeadEvent, slotOfHeader, type FinalityReading } from "./beacon.ts";
import { readEventStream, EventStreamError, type ServerSentEvent } from "./sse.ts";

/** How the feed learned of a reading. */
export type Transport = "sse" | "poll";

/** How the feed reads finality: from light-client updates, or from blocks. */
export type FeedMode = "light-client" | "blocks";

/** One new reading, with when its trigger arrived (milliseconds since 1970). */
export type FinalityObservation = FinalityReading & { readonly source: Transport; readonly receivedAt: number };

const LIGHT_CLIENT_TOPIC = "light_client_finality_update";

/** Input of {@link createFinalityFeed}. */
export type FinalityFeedInput = {
  readonly chainId: number;
  readonly beaconUrl: string;
  /** In blocks mode, a block with fewer signers than this is followed by the next one. */
  readonly minParticipants: number;
  /** Try the event stream. With false the feed only polls. */
  readonly sse: boolean;
  readonly pollMilliseconds: number;
  readonly sseOpenTimeoutMilliseconds: number;
  readonly sseIdleMilliseconds: number;
  readonly sseRetryMilliseconds: { readonly initial: number; readonly max: number };
  readonly get: JsonGet;
  readonly fetchFunction: () => typeof fetch;
  readonly logger: Logger;
  readonly now: () => number;
  readonly onObservation: (observation: FinalityObservation) => void;
};

/** A running feed. */
export interface FinalityFeed {
  start(): void;
  /** Stops the stream and the poll, and waits for the running read. */
  stop(): Promise<void>;
  /** The transport and mode in use, null before they are known. */
  state(): { readonly transport: Transport | null; readonly mode: FeedMode | null };
}

type Trigger = { readonly source: Transport; readonly receivedAt: number; readonly headSlot?: number; readonly update?: unknown };

/** A wait that ends early when `signal` aborts. */
function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Builds the feed. Nothing runs before {@link FinalityFeed.start}. */
export function createFinalityFeed(input: FinalityFeedInput): FinalityFeed {
  const { chainId, logger } = input;
  const base = input.beaconUrl.replace(/\/+$/, "");
  const stopping = new AbortController();
  let mode: FeedMode | null = null;
  let transport: Transport | null = null;
  let streamTopics: readonly string[] = [];
  let lightClientTopicRefused = false;
  let connection: AbortController | null = null;
  let last: FinalityReading | null = null;
  let pending: { readonly finalizedSlot: number; readonly headAbove: number } | null = null;
  let failing = false;
  let running: Promise<void> | null = null;
  let queued: Trigger | null = null;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let streamLoop: Promise<void> = Promise.resolve();

  const setTransport = (next: Transport): void => {
    if (transport === next) return;
    transport = next;
    logger.info("watch_transport", { chainId, transport: next, mode });
  };

  const setMode = (next: FeedMode): void => {
    if (mode === next) return;
    mode = next;
    logger.info("watch_mode", { chainId, mode: next });
    // The topics of an open stream depend on the mode: subscribe again.
    connection?.abort();
  };

  const emit = (reading: FinalityReading, trigger: Trigger): void => {
    last = reading;
    input.onObservation({ ...reading, source: trigger.source, receivedAt: trigger.receivedAt });
  };

  async function readSlot(id: "finalized" | "head"): Promise<number> {
    const answer = await input.get(`${base}/eth/v1/beacon/headers/${id}`);
    const slot = answer.status === 200 ? slotOfHeader(answer.body) : null;
    if (slot === null) throw new Error(`the beacon node answered ${answer.status} for the ${id} header`);
    return slot;
  }

  async function checkBlocks(trigger: Trigger): Promise<void> {
    const finalized = await readSlot("finalized");
    const head = trigger.headSlot ?? (await readSlot("head"));
    if ((last === null || finalized > last.finalizedSlot) && (pending === null || finalized > pending.finalizedSlot)) pending = { finalizedSlot: finalized, headAbove: head };
    if (pending === null || head <= pending.headAbove) return;
    const block = await input.get(`${base}/eth/v2/beacon/blocks/${head}`);
    if (block.status !== 200) throw new Error(`the beacon node answered ${block.status} for block ${head}`);
    const participants = participantsOfBlock(block.body);
    const reading = { finalizedSlot: pending.finalizedSlot, signatureSlot: head, participants };
    pending = participants !== null && participants >= input.minParticipants ? null : { ...pending, headAbove: head };
    emit(reading, trigger);
  }

  async function check(trigger: Trigger): Promise<void> {
    if (mode !== "blocks") {
      let body = trigger.update;
      if (body === undefined) {
        const answer = await input.get(`${base}/eth/v1/beacon/light_client/finality_update`);
        if (answer.status === 404 || answer.status === 501) {
          setMode("blocks");
          return checkBlocks(trigger);
        }
        if (answer.status !== 200) throw new Error(`the beacon node answered ${answer.status} for the finality update`);
        setMode("light-client");
        body = answer.body;
      }
      const reading = readingFromFinalityUpdate(body);
      if (reading === null) throw new Error("the beacon node sent a finality update in an unknown shape");
      const better =
        last === null || reading.finalizedSlot > last.finalizedSlot || (reading.finalizedSlot === last.finalizedSlot && (reading.participants ?? -1) > (last.participants ?? -1));
      if (better) emit(reading, trigger);
      return;
    }
    await checkBlocks(trigger);
  }

  /** Runs one check at a time. A trigger that arrives meanwhile replaces any queued one and runs next. */
  function trigger(next: Trigger): void {
    if (running !== null) {
      queued = next;
      return;
    }
    running = (async () => {
      let current: Trigger | null = next;
      while (current !== null && !stopping.signal.aborted) {
        queued = null;
        try {
          await check(current);
          if (failing) logger.info("watch_beacon_recovered", { chainId });
          failing = false;
        } catch (error) {
          // One line when reads start failing and one when they recover: a poll every slot must not flood the log.
          if (!failing) logger.warn("watch_beacon_read_failed", { chainId, error });
          failing = true;
        }
        current = queued;
      }
      running = null;
    })();
  }

  function onEvent(event: ServerSentEvent): void {
    const receivedAt = input.now();
    let data: unknown = null;
    try {
      data = JSON.parse(event.data);
    } catch {
      // A broken event triggers a read like any other; the light-client parser refuses the null.
    }
    if (event.event === LIGHT_CLIENT_TOPIC) trigger({ source: "sse", receivedAt, update: data });
    else if (event.event === "finalized_checkpoint") trigger({ source: "sse", receivedAt });
    else if (event.event === "head" && !(mode === "light-client" && streamTopics.includes(LIGHT_CLIENT_TOPIC))) {
      trigger({ source: "sse", receivedAt, ...(slotOfHeadEvent(data) === null ? {} : { headSlot: slotOfHeadEvent(data) as number }) });
    }
  }

  async function runStream(): Promise<void> {
    let delay = input.sseRetryMilliseconds.initial;
    while (!stopping.signal.aborted) {
      const topics = ["head", "finalized_checkpoint", ...(mode === "light-client" && !lightClientTopicRefused ? [LIGHT_CLIENT_TOPIC] : [])];
      connection = new AbortController();
      let failure: unknown;
      try {
        await readEventStream({
          url: `${base}/eth/v1/events?topics=${topics.join(",")}`,
          fetchFunction: input.fetchFunction(),
          openTimeoutMilliseconds: input.sseOpenTimeoutMilliseconds,
          idleMilliseconds: input.sseIdleMilliseconds,
          signal: AbortSignal.any([stopping.signal, connection.signal]),
          onOpen: () => {
            streamTopics = topics;
            delay = input.sseRetryMilliseconds.initial;
            setTransport("sse");
          },
          onEvent,
        });
        if (stopping.signal.aborted) return;
        // A mode change closed the stream to subscribe again.
        if (connection.signal.aborted) continue;
        failure = new EventStreamError("the beacon node closed the stream", 200);
      } catch (error) {
        failure = error;
      }
      if (failure instanceof EventStreamError && failure.status === 400 && topics.includes(LIGHT_CLIENT_TOPIC)) {
        lightClientTopicRefused = true;
        logger.info("watch_sse_topic_refused", { chainId, topic: LIGHT_CLIENT_TOPIC });
        continue;
      }
      streamTopics = [];
      setTransport("poll");
      logger.warn("watch_sse_failed", { chainId, error: failure, retryInSeconds: delay / 1000 });
      trigger({ source: "poll", receivedAt: input.now() });
      await sleep(delay, stopping.signal);
      delay = Math.min(delay * 2, input.sseRetryMilliseconds.max);
    }
  }

  return {
    start() {
      pollTimer = setInterval(() => {
        if (transport !== "sse") trigger({ source: "poll", receivedAt: input.now() });
      }, input.pollMilliseconds);
      pollTimer.unref();
      // The first look finds the mode, so the stream subscribes to the right topics.
      trigger({ source: "poll", receivedAt: input.now() });
      if (!input.sse) {
        setTransport("poll");
        return;
      }
      // The first look is running now; the stream starts when it is done.
      streamLoop = (running as unknown as Promise<void>).then(runStream);
    },
    async stop() {
      stopping.abort();
      clearInterval(pollTimer);
      await streamLoop;
      await running;
    },
    state: () => ({ transport, mode }),
  };
}
