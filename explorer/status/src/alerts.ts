import type { Logger } from "../../backend/src/logger.ts";
import { sanitize } from "./sanitize.ts";
import type { CheckResult, State } from "./types.ts";

/** The checks that are watched when the configuration names none. */
export const DEFAULT_ALERT_PREFIX = "lightclient-deadline-";

const POST_TIMEOUT_MILLISECONDS = 10_000;

export interface Alerter {
  /** `before` is the state of the previous round (or the stored one after a start); undefined for a check seen for the first time. Never throws. */
  notify(result: CheckResult, name: string, before: State | undefined): Promise<void>;
}

export type AlerterInput = {
  /** The resolved webhook URL. It is never logged. */
  readonly url: string;
  /** Explicit check ids; absent means every `lightclient-deadline-*` check. */
  readonly checks: readonly string[] | undefined;
  readonly fetch: typeof fetch;
  readonly logger: Logger;
  readonly now: () => number;
  readonly secrets: () => readonly string[];
};

/**
 * Posts to a webhook when a watched check enters down (the state before was not down) and once more when it leaves down
 * ("recovered"). The body has `text` (Slack style) and `content` (Discord style) with the same sentence, plus the fields.
 * A failed post is logged with the status or the error message, never the URL, and does not stop the round.
 */
export function createAlerter(input: AlerterInput): Alerter {
  const watched = (id: string): boolean => (input.checks === undefined ? id.startsWith(DEFAULT_ALERT_PREFIX) : input.checks.includes(id));

  const post = async (result: CheckResult, name: string, state: State, text: string): Promise<void> => {
    const body = { text, content: text, check: result.id, name, state, detail: result.detail, at: input.now() };
    try {
      const response = await input.fetch(input.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(POST_TIMEOUT_MILLISECONDS),
      });
      if (!response.ok) input.logger.warn("alert_failed", { check: result.id, status: response.status });
    } catch (error) {
      input.logger.warn("alert_failed", { check: result.id, error: sanitize(error instanceof Error ? error.message : String(error), input.secrets()) });
    }
  };

  return {
    async notify(result, name, before) {
      if (!watched(result.id)) return;
      if (result.state === "down" && before !== "down") await post(result, name, "down", `${name}: ${result.detail}`);
      else if (result.state !== "down" && before === "down") await post(result, name, result.state, `${name} recovered: ${result.detail}`);
    },
  };
}
