import { redactSecrets } from "@zk-bridge/shared/config";

/** The longest detail that a check stores, in characters. */
export const MAXIMUM_DETAIL_LENGTH = 200;

/**
 * Makes a message safe to store and to show on the public page: no URL (an endpoint can carry a key), none of the
 * secret values the process holds, no long token, one line, and at most {@link MAXIMUM_DETAIL_LENGTH} characters.
 */
export function sanitize(text: string, knownSecrets: readonly string[] = []): string {
  const withoutSecrets = redactSecrets(text, knownSecrets.filter((secret) => secret !== ""));
  const oneLine = withoutSecrets
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length <= MAXIMUM_DETAIL_LENGTH ? oneLine : `${oneLine.slice(0, MAXIMUM_DETAIL_LENGTH - 3)}...`;
}
