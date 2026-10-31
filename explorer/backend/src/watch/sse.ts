/**
 * A small reader of `text/event-stream` (server-sent events), as the beacon API serves `/eth/v1/events`. No dependency:
 * fetch, a stream reader and a line parser.
 */
import { USER_AGENT } from "../keepalive/sources.ts";

/** One event: its name (`message` when the stream names none) and its data lines joined by line breaks. */
export type ServerSentEvent = { readonly event: string; readonly data: string };

/**
 * Builds a parser that takes text in any pieces and calls `onEvent` for each finished event. Follows the
 * event-stream rules that a beacon node uses: `event:` and `data:` fields, a blank line ends an event, a line that
 * starts with `:` is a comment, and lines may end in `\n`, `\r\n` or `\r`.
 */
export function createSseParser(onEvent: (event: ServerSentEvent) => void): { push(text: string): void } {
  let buffer = "";
  let name = "";
  let data: string[] = [];
  const line = (text: string): void => {
    if (text === "") {
      if (data.length > 0) onEvent({ event: name === "" ? "message" : name, data: data.join("\n") });
      name = "";
      data = [];
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    const value = colon === -1 ? "" : text.slice(colon + 1).replace(/^ /, "");
    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  };
  return {
    push(text) {
      buffer += text;
      // A trailing `\r` may be the first half of `\r\n`: keep it until the next piece.
      const lines = buffer.split(/\r\n|\n|\r(?!$)/);
      buffer = lines.pop() as string;
      for (const entry of lines) line(entry);
    },
  };
}

/** The stream could not open, or broke. `status` is the HTTP status when the node answered one. */
export class EventStreamError extends Error {
  override readonly name = "EventStreamError";
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

/** Input of {@link readEventStream}. */
export type EventStreamInput = {
  readonly url: string;
  readonly fetchFunction: typeof fetch;
  /** The stream fails when the node sends no headers within this many milliseconds. */
  readonly openTimeoutMilliseconds: number;
  /** The stream fails when no byte arrives for this many milliseconds. A beacon node sends a head event every slot. */
  readonly idleMilliseconds: number;
  /** Aborting it ends the stream quietly. */
  readonly signal: AbortSignal;
  readonly onOpen: () => void;
  readonly onEvent: (event: ServerSentEvent) => void;
};

/**
 * Reads an event stream until it ends or `signal` aborts.
 *
 * @throws EventStreamError when the node does not answer in time, answers a status other than 200 or another content
 *   type, or goes silent. Any error of fetch or of the body passes through.
 */
export async function readEventStream(input: EventStreamInput): Promise<void> {
  const controller = new AbortController();
  const stopFromOutside = () => controller.abort();
  input.signal.addEventListener("abort", stopFromOutside, { once: true });
  let timer = setTimeout(() => controller.abort(new EventStreamError(`no answer within ${input.openTimeoutMilliseconds / 1000} s`, null)), input.openTimeoutMilliseconds);
  try {
    const response = await input.fetchFunction(input.url, { headers: { accept: "text/event-stream", "user-agent": USER_AGENT }, signal: controller.signal });
    clearTimeout(timer);
    if (response.status !== 200) throw new EventStreamError(`the beacon node answered ${response.status}`, response.status);
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream") || response.body === null) {
      throw new EventStreamError("the beacon node did not answer an event stream", response.status);
    }
    input.onOpen();
    const parser = createSseParser(input.onEvent);
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    const idle = () => controller.abort(new EventStreamError(`no event for ${input.idleMilliseconds / 1000} s`, 200));
    timer = setTimeout(idle, input.idleMilliseconds);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      clearTimeout(timer);
      timer = setTimeout(idle, input.idleMilliseconds);
      parser.push(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    if (input.signal.aborted) return;
    const reason: unknown = controller.signal.reason;
    throw reason instanceof EventStreamError ? reason : error;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", stopFromOutside);
    controller.abort();
  }
}
