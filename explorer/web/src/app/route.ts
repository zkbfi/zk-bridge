/**
 * The address of a page. The page keeps its place in the URL hash, so a link opens the same view and the back button
 * works. Parsing and formatting are pure and tested together: every route survives a round trip.
 */
import { getAddress, isAddress, type Address, type Hex } from "viem";

/** The place that the page shows. */
export type Route =
  | { readonly name: "global" }
  | { readonly name: "pair"; readonly pairId: string; readonly token: Address | null }
  | { readonly name: "audit" }
  | { readonly name: "prover" }
  | { readonly name: "settings" }
  | { readonly name: "docs"; readonly slug: string | null; readonly heading: string | null }
  | { readonly name: "address"; readonly address: Address }
  | { readonly name: "message"; readonly messageId: Hex };

/** The route when the hash is empty or unreadable. */
export const HOME_ROUTE: Route = { name: "global" };

const MESSAGE_IDENTIFIER = /^0x[0-9a-fA-F]{64}$/;

/**
 * Reads a hash such as `#/pair/eth-pls?token=0x...`. An unknown hash gives the home route.
 *
 * @param hash The `location.hash` text, with or without the `#`.
 */
export const parseRoute = (hash: string): Route => {
  const text = hash.replace(/^#/, "");
  const [path = "", query = ""] = text.split("?");
  const parts = path.split("/").filter((part) => part !== "").map(decodeURIComponent);
  const [head, first, second] = parts;
  if (head === undefined) return HOME_ROUTE;
  if (head === "pair" && first !== undefined) {
    const token = new URLSearchParams(query).get("token");
    return { name: "pair", pairId: first, token: token !== null && isAddress(token, { strict: false }) ? getAddress(token) : null };
  }
  if (head === "audit") return { name: "audit" };
  if (head === "prover") return { name: "prover" };
  if (head === "settings") return { name: "settings" };
  if (head === "docs") return { name: "docs", slug: first ?? null, heading: second ?? null };
  if (head === "address" && first !== undefined && isAddress(first, { strict: false })) return { name: "address", address: getAddress(first) };
  if (head === "message" && first !== undefined && MESSAGE_IDENTIFIER.test(first)) return { name: "message", messageId: first.toLowerCase() as Hex };
  return HOME_ROUTE;
};

/**
 * Writes the hash of a route.
 *
 * @param route The route.
 */
export const formatRoute = (route: Route): string => {
  if (route.name === "global") return "#/";
  if (route.name === "audit") return "#/audit";
  if (route.name === "prover") return "#/prover";
  if (route.name === "settings") return "#/settings";
  if (route.name === "address") return `#/address/${route.address}`;
  if (route.name === "message") return `#/message/${route.messageId}`;
  if (route.name === "pair") return `#/pair/${encodeURIComponent(route.pairId)}${route.token === null ? "" : `?token=${route.token}`}`;
  const slug = route.slug === null ? "" : `/${encodeURIComponent(route.slug)}`;
  const heading = route.slug === null || route.heading === null ? "" : `/${encodeURIComponent(route.heading)}`;
  return `#/docs${slug}${heading}`;
};

/** The name of the view of a route, for the title of the page and for the active mark in the palette. */
export const routeTitle = (route: Route): string => {
  const titles: Record<Route["name"], string> = {
    global: "Global view",
    pair: "Pair view",
    audit: "Audit",
    prover: "Prover and costs",
    settings: "Connections",
    docs: "Docs",
    address: "Address",
    message: "Transfer or message",
  };
  return titles[route.name];
};
