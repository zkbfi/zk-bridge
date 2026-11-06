import { redactSecrets } from "@zk-bridge/shared/config";

/** The longest detail that a check stores, in characters. */
export const MAXIMUM_DETAIL_LENGTH = 200;

const LONG_TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;
/** An address: 0x and 40 hex. Public on a chain, and too short to be a private key. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** 0x and 64 hex: a hash, a root, or a private key, which look the same. Shown shortened, never whole. */
const HEX_64 = /^0x[0-9a-fA-F]{64}$/;
/** A CID: version 1 (base32, "baf...") or version 0 ("Qm...", 46 characters). Public by design. */
const CID = /^(?:baf[a-z2-7]{40,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;
/** A name: lowercase words of at most 16 letters joined by dashes or underscores, like detect-beacon-roots-and-registry. */
const WORDS = /^[a-z]{1,16}(?:[-_][a-z0-9]{1,16})+$/i;
/** A contract or type name: capitalised words of 3 to 16 letters, like BeaconForkGateWithRegistryAndDetection. */
const CAMEL_WORDS = /^(?:[A-Z][a-z]{2,15}){2,}$/;
/** Base64's look: +, = or mixed case with a digit. Such a token is hidden whole, even across a slash. */
const BASE64_LOOK = /[+=]|^(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])/;

/**
 * What a long token becomes on the public page. A long token is a key unless it has a public shape: an address, a CID,
 * or a name made of short words. 0x and 64 hex may be a private key as well as a hash, so only its first and last four
 * digits stay, which tell hashes apart and give nothing away.
 */
function shown(token: string): string {
  if (ADDRESS.test(token) || CID.test(token) || WORDS.test(token) || CAMEL_WORDS.test(token)) return token;
  if (HEX_64.test(token)) return `${token.slice(0, 6)}…${token.slice(-4)}`;
  return "[redacted]";
}

/** Hides the long tokens that are not public shapes; a slash splits a path into its segments. */
function hideKeys(text: string): string {
  return text.replace(LONG_TOKEN, (token) => {
    if (!token.includes("/") || BASE64_LOOK.test(token)) return shown(token);
    return token.split("/").map((part) => (part.length >= 32 ? shown(part) : part)).join("/");
  });
}

/**
 * Makes a message safe to store and to show on the public page: no URL (an endpoint can carry a key), none of the
 * secret values the process holds, no long token unless it has a public shape (addresses, CIDs and names made of short
 * words stay; 0x and 64 hex is shortened, since a private key looks the same), one line, and at most {@link MAXIMUM_DETAIL_LENGTH} characters.
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
