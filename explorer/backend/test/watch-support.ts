/** Fakes of the watch tests: a beacon node with an event stream the test drives, and its JSON answers. */

/** `sync_committee_bits` with the first `count` of 512 bits set. */
export function bits(count: number): string {
  const bytes = new Uint8Array(64);
  for (let index = 0; index < count; index += 1) bytes[index >> 3] = (bytes[index >> 3] as number) | (1 << (index & 7));
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

/** A light-client finality update as the beacon API serves it. */
export function finalityUpdate(finalizedSlot: number, participants: number, signatureSlot = finalizedSlot + 65) {
  return {
    version: "electra",
    data: {
      attested_header: { beacon: { slot: String(signatureSlot - 1) } },
      finalized_header: { beacon: { slot: String(finalizedSlot) } },
      finality_branch: [],
      sync_aggregate: { sync_committee_bits: bits(participants), sync_committee_signature: "0x00" },
      signature_slot: String(signatureSlot),
    },
  };
}

/** A header answer. */
export const header = (slot: number) => ({ data: { header: { message: { slot: String(slot) } } } });

/** A block answer with a sync aggregate. */
export const block = (participants: number) => ({ data: { message: { body: { sync_aggregate: { sync_committee_bits: bits(participants) } } } } });

/** How the fake answers `/eth/v1/events`. */
export type StreamBehaviour = "open" | "hang" | { status: number } | "html";

/**
 * A beacon node. `answers` maps a path (with its query) to a status and a body; a missing path answers 404. Each
 * accepted event stream is kept in `streams`, newest last, and the test sends events into it.
 */
export function fakeBeacon(base = "http://beacon.test") {
  const answers = new Map<string, { status: number; body: unknown }>();
  const streams: Array<{ topics: string; send(event: string, data: unknown): void; sendRaw(text: string): void; close(): void; closed: boolean }> = [];
  const requests: string[] = [];
  let stream: StreamBehaviour = "open";
  const fetchFunction = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    requests.push(path);
    const signal = init?.signal ?? undefined;
    if (url.pathname === "/eth/v1/events") {
      if (stream === "hang") {
        return new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      if (stream === "html") return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
      if (typeof stream === "object") return new Response(null, { status: stream.status });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (value) => void (controller = value) });
      const entry = {
        topics: url.searchParams.get("topics") ?? "",
        closed: false,
        sendRaw(text: string) {
          if (!entry.closed) controller.enqueue(new TextEncoder().encode(text));
        },
        send(event: string, data: unknown) {
          entry.sendRaw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        close() {
          if (entry.closed) return;
          entry.closed = true;
          controller.close();
        },
      };
      signal?.addEventListener("abort", () => {
        if (entry.closed) return;
        entry.closed = true;
        controller.error(new DOMException("aborted", "AbortError"));
      }, { once: true });
      streams.push(entry);
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const answer = answers.get(path);
    if (answer === undefined) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    base,
    answers,
    streams,
    requests,
    fetchFunction,
    /** Sets the answer of a path. */
    set(path: string, body: unknown, status = 200) {
      answers.set(path, { status, body });
    },
    /** How the next event streams answer. */
    streamAnswers(behaviour: StreamBehaviour) {
      stream = behaviour;
    },
    /** The newest stream. */
    latest() {
      const entry = streams[streams.length - 1];
      if (entry === undefined) throw new Error("no stream is open");
      return entry;
    },
  };
}

/** Lets the pending promises and the zero-delay work run. */
export async function flush(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
