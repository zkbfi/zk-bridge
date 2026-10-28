/** The key of every request that has no socket address. They share one bucket with a low limit. */
export const UNKNOWN_CALLER = "unknown";

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Turns the text form of an IPv6 address into its eight groups, or null when the text is not an address. */
function ipv6Groups(address: string): number[] | null {
  const [head = "", tail, ...extra] = address.split("::");
  if (extra.length > 0) return null;
  const toGroups = (text: string): number[] | null => {
    if (text === "") return [];
    const parsed = text.split(":").map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : Number.NaN));
    return parsed.some(Number.isNaN) ? null : parsed;
  };
  const front = toGroups(head);
  const back = toGroups(tail ?? "");
  if (front === null || back === null) return null;
  if (tail === undefined) return front.length === 8 ? front : null;
  const missing = 8 - front.length - back.length;
  return missing < 1 ? null : [...front, ...Array<number>(missing).fill(0), ...back];
}

/**
 * The key that the rate limits count for one address. An IPv4 address is its own key. An IPv6 address is keyed by its
 * first 64 bits, because one person holds a whole /64 network and can switch addresses inside it at will.
 * An IPv4 address inside an IPv6 address (`::ffff:1.2.3.4`) counts as the IPv4 address. Text that is no address stays as it is.
 */
export function callerKey(address: string): string {
  const withoutZone = address.replace(/%.*$/, "");
  const mapped = IPV4_MAPPED.exec(withoutZone);
  if (mapped !== null) return mapped[1] as string;
  if (!withoutZone.includes(":")) return withoutZone;
  const groups = ipv6Groups(withoutZone);
  if (groups === null) return withoutZone;
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}
