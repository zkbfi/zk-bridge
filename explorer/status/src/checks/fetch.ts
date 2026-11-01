import type { Deps } from "../deps.ts";

export type Answer = { readonly status: number; readonly ms: number; readonly text: string };

/**
 * One GET. Throws when the request fails or takes longer than the request timeout. With `body: false` the body is not
 * read (a gateway may answer a large file).
 */
export async function get(deps: Deps, url: string, options: { headers?: Record<string, string>; body?: boolean } = {}): Promise<Answer> {
  const started = deps.now();
  const response = await deps.fetch(url, { headers: { accept: "application/json", ...options.headers }, signal: AbortSignal.timeout(deps.requestTimeoutMilliseconds) });
  let text = "";
  if (options.body === false) await response.body?.cancel();
  else text = await response.text();
  return { status: response.status, ms: deps.now() - started, text };
}

/** The body as JSON, or null when it is not JSON. */
export const json = (answer: Answer): unknown => {
  try {
    return JSON.parse(answer.text);
  } catch {
    return null;
  }
};

/** Whether the answer took longer than the slow limit of the configuration. */
export const isSlow = (deps: Deps, answer: Answer): boolean => answer.ms > deps.config.slowSeconds * 1000;

/** `3.4 s`. */
export const seconds = (milliseconds: number): string => `${(milliseconds / 1000).toFixed(1)} s`;

/** `1 module`, `2 modules`. */
export const count = (amount: number, noun: string): string => `${amount} ${noun}${amount === 1 ? "" : "s"}`;
