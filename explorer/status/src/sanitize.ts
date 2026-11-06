import { redactSecrets } from "@zk-bridge/shared/config";

/** The longest detail that a check stores, in characters. */
export const MAXIMUM_DETAIL_LENGTH = 200;

const LONG_TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;
/** Upper and lower case letters and a digit: the look of base64, not of a path or a name. */
const MIXED_CASE_WITH_DIGIT = /^(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])/;
const SEGMENT_LENGTH = 32;
/** A hash or an address with its 0x: public on a chain. */
const PUBLIC_HEX = /^0x[0-9a-f]+$/i;
/** A CID: version 1 (base32, "baf...") or version 0 ("Qm...", 46 characters). Public by design. */
const CID = /^(?:baf[a-z2-7]{40,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;

/**
 * Whether a long token looks like a key rather than a word. A word, a mode name, a contract name or a check id has
 * letters, dashes and underscores only. A key has digits (a hex or base64 secret), or base64's `+` and `=`. A hash with
 * 0x and a CID have digits too but are public, so they stay.
 */
function looksSecret(token: string): boolean {
  if (PUBLIC_HEX.test(token) || CID.test(token)) return false;
  return /[0-9+]/.test(token) || token.endsWith("=");
}

/** Hides the long tokens that look like keys; a slash splits a path into its segments unless the whole is base64. */
function hideKeys(text: string): string {
  return text.replace(LONG_TOKEN, (token) => {
    const wholeBase64 = /[+=]/.test(token) || MIXED_CASE_WITH_DIGIT.test(token);
    if (!token.includes("/") || wholeBase64) return looksSecret(token) ? "[redacted]" : token;
    return token.split("/").map((part) => (part.length >= SEGMENT_LENGTH && looksSecret(part) ? "[redacted]" : part)).join("/");
  });
}

/**
 * Makes a message safe to store and to show on the public page: no URL (an endpoint can carry a key), none of the
 * secret values the process holds, no token that looks like a key (long hex or base64; mode names, contract names,
 * check ids, CIDs and 0x hashes stay readable), one line, and at most {@link MAXIMUM_DETAIL_LENGTH} characters.
 */
export function sanitize(text: string, knownSecrets: readonly string[] = []): string {
  const withoutSecrets = redactSecrets(text, knownSecrets.filter((secret) => secret !== ""));
  const oneLine = withoutSecrets
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/\s+/g, " ")
    .trim();
  const readable = hideKeys(oneLine);
  return readable.length <= MAXIMUM_DETAIL_LENGTH ? readable : `${readable.slice(0, MAXIMUM_DETAIL_LENGTH - 3)}...`;
}
