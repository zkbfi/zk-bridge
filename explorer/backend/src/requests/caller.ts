/** The key of every request that has no usable address. They share one bucket with a low limit. */
export const UNKNOWN_CALLER = "unknown";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const BRACKETED = /^\[([^\]]+)\](?::\d+)?$/;
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/;

/** The four octets of a dotted IPv4 address, or null. */
function ipv4Octets(text: string): number[] | null {
  const match = IPV4.exec(text);
  if (match === null) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** A list of IPv6 groups written between colons, or null when a group is not hex of one to four digits. */
function toGroups(text: string): number[] | null {
  if (text === "") return [];
  const parsed = text.split(":").map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : Number.NaN));
  return parsed.some(Number.isNaN) ? null : parsed;
}

/** Replaces a dotted IPv4 tail by its two hex groups. Returns null when the tail is not an IPv4 address. */
function withoutDottedTail(address: string): string | null {
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  if (!tail.includes(".")) return address;
  const octets = ipv4Octets(tail);
  if (octets === null) return null;
  const [a, b, c, d] = octets as [number, number, number, number];
  return `${address.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
}

/** The eight groups of an IPv6 address, or null when the text is not one. */
function ipv6Groups(address: string): number[] | null {
  const plain = withoutDottedTail(address);
  if (plain === null) return null;
  const [head = "", tail, ...extra] = plain.split("::");
  if (extra.length > 0) return null;
  const front = toGroups(head);
  const back = toGroups(tail ?? "");
  if (front === null || back === null) return null;
  if (tail === undefined) return front.length === 8 ? front : null;
  const missing = 8 - front.length - back.length;
  return missing < 1 ? null : [...front, ...Array<number>(missing).fill(0), ...back];
}

/** Removes the brackets, the port and the zone from the text of one address. */
function bareAddress(text: string): string {
  const entry = text.trim();
  const bracketed = BRACKETED.exec(entry);
  const inner = bracketed?.[1] ?? IPV4_WITH_PORT.exec(entry)?.[1] ?? entry;
  return inner.replace(/%.*$/, "");
}

/**
 * The key that the rate limits count for one address, as it appears in a socket or a forwarded entry.
 *
 * - An IPv4 address is its own key. A port is dropped.
 * - An IPv6 address is keyed by its first 64 bits, because one person holds a whole /64 network. Brackets, a port, a
 *   zone and a dotted IPv4 tail are understood.
 * - An IPv4 address inside an IPv6 address (`::ffff:1.2.3.4` or `::ffff:102:304`) is keyed as the IPv4 address.
 * - Text that is no address gives {@link UNKNOWN_CALLER}, never the raw text, so a client cannot make up keys.
 */
export function callerKey(text: string): string {
  const address = bareAddress(text);
  const octets = ipv4Octets(address);
  if (octets !== null) return octets.join(".");
  const groups = ipv6Groups(address);
  if (groups === null) return UNKNOWN_CALLER;
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = groups as [number, number, number, number, number, number, number, number];
  if (first + second + third + fourth + fifth === 0 && sixth === 0xffff) {
    return [seventh >> 8, seventh & 255, eighth >> 8, eighth & 255].join(".");
  }
  return `${[first, second, third, fourth].map((group) => group.toString(16)).join(":")}::/64`;
}
