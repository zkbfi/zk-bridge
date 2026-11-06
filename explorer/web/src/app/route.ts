/**
 * The address of a page. The page keeps its place in the URL hash, so a link opens the same view and the back button
 * works. Parsing and formatting are pure and tested together: every route survives a round trip.
 */
import { DEFAULT_MAXIMUM_BLOCKS, type HistoryFilters } from "@zk-bridge/shared";
import { FEED_STATUSES, type Direction } from "@terminal/model/types";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { formatHistoryQuery, historyFiltersFromQuery } from "../views/history-model";

/** The kinds of Explore page. `browse` lists one kind (its id names it). */
export const EXPLORE_KINDS = ["tx", "address", "proof", "block", "slot", "token", "contract", "gate", "release", "costs", "browse"] as const;

/**
 * One Explore page. `chainId` is set for what lives on one chain (a transaction, a proof, a block, a contract, a gate);
 * `id` is the hash, address, number, `<side>:<address>` (token), CID (release) or the kind to browse.
 */
export type ExplorePage = {
  readonly kind: (typeof EXPLORE_KINDS)[number];
  readonly id: string;
  readonly chainId?: number;
  /** A `browse` page keeps its filters, sort and page number here, as a query string without the `?`. */
  readonly query?: string;
};

const ON_CHAIN: ReadonlySet<ExplorePage["kind"]> = new Set(["tx", "proof", "block", "contract", "gate"]);

const explorePageOf = (parts: readonly string[]): ExplorePage | null => {
  const [kind, first, second] = parts;
  if (!(EXPLORE_KINDS as readonly string[]).includes(kind ?? "")) return null;
  const known = kind as ExplorePage["kind"];
  if (known === "costs") return first === undefined ? { kind: known, id: "" } : null;
  if (known === "gate") return first !== undefined && /^\d+$/.test(first) ? { kind: known, chainId: Number(first), id: first } : null;
  if (ON_CHAIN.has(known)) {
    if (first === undefined || second === undefined || !/^\d+$/.test(first)) return null;
    const valid = known === "tx" ? /^0x[0-9a-fA-F]{64}$/.test(second) : known === "contract" ? /^0x[0-9a-fA-F]{40}$/.test(second) : /^\d+$/.test(second);
    return valid ? { kind: known, chainId: Number(first), id: second } : null;
  }
  if (first === undefined) return null;
  if (known === "token") return (first === "first" || first === "second") && second !== undefined && /^0x[0-9a-fA-F]{40}$/.test(second) ? { kind: known, id: `${first}:${second}` } : null;
  if (known === "address") return /^0x[0-9a-fA-F]{40}$/.test(first) ? { kind: known, id: first } : null;
  if (known === "slot") return /^\d+$/.test(first) ? { kind: known, id: first } : null;
  if (known === "release") return /^[A-Za-z0-9]{10,}$/.test(first) ? { kind: known, id: first } : null;
  return /^[a-z-]+$/.test(first) ? { kind: known, id: first } : null;
};

const formatExplore = (route: Extract<Route, { name: "explore" }>): string => {
  if (route.page === undefined) return route.q === undefined || route.q === "" ? "#/explore" : `#/explore?${new URLSearchParams({ q: route.q }).toString()}`;
  const { kind, id, chainId } = route.page;
  if (kind === "costs") return "#/explore/costs";
  if (kind === "gate") return `#/explore/gate/${chainId ?? id}`;
  if (kind === "token") return `#/explore/token/${id.replace(":", "/")}`;
  if (chainId !== undefined && ON_CHAIN.has(kind)) return `#/explore/${kind}/${chainId}/${id}`;
  const path = `#/explore/${kind}/${encodeURIComponent(id)}`;
  return kind === "browse" && route.page.query !== undefined && route.page.query !== "" ? `${path}?${route.page.query}` : path;
};

/** The place that the page shows. */
export type Route =
  /** No hash, or one the page does not know. The page shows the default pair in its place (see {@link resolveHome}). */
  | { readonly name: "home" }
  /** The bridge screen (home): the pair, the direction, and the form fields that differ from the defaults. */
  | { readonly name: "bridge"; readonly pairId: string; readonly dir: Direction; readonly form?: BridgeQuery }
  | { readonly name: "activity" }
  /** Explore: the top (with a search in `q`), or one page of it. */
  | { readonly name: "explore"; readonly q?: string; readonly page?: ExplorePage }
  /** The table of every pair, at `#/pairs`. It is never the landing page. */
  | { readonly name: "global" }
  | { readonly name: "pair"; readonly pairId: string; readonly token: Address | null; readonly view?: PairViewQuery }
  | { readonly name: "audit" }
  | { readonly name: "prover" }
  | { readonly name: "settings" }
  | { readonly name: "history"; readonly filters: HistoryFilters; readonly scanBlocks?: bigint }
  | { readonly name: "docs"; readonly slug: string | null; readonly heading: string | null }
  | { readonly name: "address"; readonly address: Address }
  | { readonly name: "message"; readonly messageId: Hex };

/** The route when the hash is empty or unreadable. */
export const HOME_ROUTE: Route = { name: "home" };

/**
 * The feed filters and the row count of the pair view, beyond the token. Only what differs from the default is
 * present, so a default view has no `view` and its link stays short.
 */
export type PairViewQuery = {
  readonly direction?: "first-to-second" | "second-to-first";
  readonly kind?: "token" | "message";
  readonly status?: (typeof FEED_STATUSES)[number];
  /** The address filter as typed: hex, possibly still incomplete. */
  readonly address?: string;
  readonly range?: "1h" | "24h" | "7d";
  /** How many feed rows the view shows; a multiple of {@link PAIR_PAGE_SIZE}. */
  readonly rows?: number;
};

/** The rows that the pair view shows at first and adds with every "Show older rows". */
export const PAIR_PAGE_SIZE = 50;
const MAXIMUM_ROWS = 1000;

/**
 * Opens the bridge on the default pair, sending from its first chain, in place of the home route, so loading the page
 * lands on the bridge, never on a chooser.
 *
 * @param route The parsed route.
 * @param defaultPairId The pair that this page was built for.
 */
export const resolveHome = (route: Route, defaultPairId: string): Route =>
  route.name === "home" ? { name: "bridge", pairId: defaultPairId, dir: "first-to-second" } : route;

/**
 * A bridge route for a pair this build does not have moves to the build's pair; `unknown` names the pair asked for, so
 * the page can say so instead of showing another pair under the wrong address.
 *
 * @param route The route read from the address.
 * @param pairId The pair this build serves.
 */
export const resolvePair = (route: Route, pairId: string): { readonly route: Route; readonly unknown: string | null } =>
  route.name === "bridge" && route.pairId !== pairId ? { route: { ...route, pairId }, unknown: route.pairId } : { route, unknown: null };

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
  if (head === "pairs") return { name: "global" };
  if (head === "activity") return { name: "activity" };
  if (head === "explore") {
    const page = explorePageOf(parts.slice(1));
    if (page !== null) return { name: "explore", page: page.kind === "browse" && query !== "" ? { ...page, query } : page };
    const q = new URLSearchParams(query).get("q");
    return q === null || q.trim() === "" ? { name: "explore" } : { name: "explore", q };
  }
  if (head === "bridge" && first !== undefined) {
    const params = new URLSearchParams(query);
    const form = bridgeOf(params);
    return {
      name: "bridge",
      pairId: first,
      dir: oneOf(DIRECTIONS, params.get("dir")) ?? "first-to-second",
      ...(Object.keys(form).length === 0 ? {} : { form }),
    };
  }
  if (head === "pair" && first !== undefined) {
    const params = new URLSearchParams(query);
    const token = params.get("token");
    const view = pairViewOf(params);
    return {
      name: "pair",
      pairId: first,
      token: token !== null && isAddress(token, { strict: false }) ? getAddress(token) : null,
      ...(view === null ? {} : { view }),
    };
  }
  if (head === "audit") return { name: "audit" };
  if (head === "prover") return { name: "prover" };
  if (head === "settings") return { name: "settings" };
  if (head === "history") {
    const params = new URLSearchParams(query);
    const scanBlocks = scanBlocksOf(params.get("scan"));
    for (const name of [...params.keys()]) if (name === "scan" || isOverlayKey(name)) params.delete(name);
    return { name: "history", filters: historyFiltersFromQuery(params.toString()), ...(scanBlocks === null ? {} : { scanBlocks }) };
  }
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
  if (route.name === "home") return "#/";
  if (route.name === "global") return "#/pairs";
  if (route.name === "activity") return "#/activity";
  if (route.name === "explore") return formatExplore(route);
  if (route.name === "bridge") {
    const params = new URLSearchParams();
    if (route.dir !== "first-to-second") params.set("dir", route.dir);
    if (route.form !== undefined) writeBridge(params, route.form);
    const query = params.toString();
    return `#/bridge/${encodeURIComponent(route.pairId)}${query === "" ? "" : `?${query}`}`;
  }
  if (route.name === "audit") return "#/audit";
  if (route.name === "prover") return "#/prover";
  if (route.name === "settings") return "#/settings";
  if (route.name === "history") {
    const query = formatHistoryQuery(route.filters);
    const scan = route.scanBlocks === undefined || route.scanBlocks === DEFAULT_MAXIMUM_BLOCKS ? "" : `scan=${route.scanBlocks}`;
    const joined = [query, scan].filter((part) => part !== "").join("&");
    return `#/history${joined === "" ? "" : `?${joined}`}`;
  }
  if (route.name === "address") return `#/address/${route.address}`;
  if (route.name === "message") return `#/message/${route.messageId}`;
  if (route.name === "pair") {
    const params = new URLSearchParams();
    if (route.token !== null) params.set("token", route.token);
    writePairView(params, route.view);
    const query = params.toString();
    return `#/pair/${encodeURIComponent(route.pairId)}${query === "" ? "" : `?${query}`}`;
  }
  const slug = route.slug === null ? "" : `/${encodeURIComponent(route.slug)}`;
  const heading = route.slug === null || route.heading === null ? "" : `/${encodeURIComponent(route.heading)}`;
  return `#/docs${slug}${heading}`;
};

/** The name of the view of a route, for the title of the page and for the active mark in the palette. */
export const routeTitle = (route: Route): string => {
  const titles: Record<Route["name"], string> = {
    home: "Bridge",
    bridge: "Bridge",
    activity: "Activity",
    explore: "Explore",
    global: "Global view",
    pair: "Pair view",
    audit: "Audit",
    prover: "Prover and costs",
    settings: "Connections",
    history: "History",
    docs: "Docs",
    address: "Address",
    message: "Transfer or message",
  };
  return titles[route.name];
};

// ---- the pair view and the history scan ---------------------------------------------------------------------------

const DIRECTIONS = ["first-to-second", "second-to-first"] as const;
const KINDS = ["token", "message"] as const;
const RANGES = ["1h", "24h", "7d"] as const;

/** The value if it is one of the allowed ones, else undefined. A crafted link cannot smuggle in another value. */
const oneOf = <T extends string>(allowed: readonly T[], value: string | null): T | undefined =>
  value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

/** Hex text while it is typed: an optional 0x and at most `digits` hex digits. Anything else is dropped. */
const hexText = (value: string | null, digits: number): string | undefined =>
  value !== null && value.length <= digits + 2 && /^(0x)?[0-9a-fA-F]*$/.test(value) ? value : undefined;

/** Decimal text while it is typed, such as `1.`, `0,5` or `12`. */
const decimalText = (value: string | null): string | undefined => (value !== null && value.length <= 40 && /^[0-9]*[.,]?[0-9]*$/.test(value) ? value : undefined);

/** Whole-number text while it is typed. */
const digitsText = (value: string | null): string | undefined => (value !== null && /^[0-9]{0,12}$/.test(value) ? value : undefined);

const pairViewOf = (params: URLSearchParams): PairViewQuery | null => {
  const rowsText = params.get("rows");
  const rowsNumber = rowsText !== null && /^[0-9]{1,5}$/.test(rowsText) ? Number(rowsText) : PAIR_PAGE_SIZE;
  const rows = Math.min(MAXIMUM_ROWS, Math.max(PAIR_PAGE_SIZE, Math.ceil(rowsNumber / PAIR_PAGE_SIZE) * PAIR_PAGE_SIZE));
  const view: PairViewQuery = {
    ...optional("direction", oneOf(DIRECTIONS, params.get("direction"))),
    ...optional("kind", oneOf(KINDS, params.get("kind"))),
    ...optional("status", oneOf(FEED_STATUSES, params.get("status"))),
    ...optional("address", nonEmpty(hexText(params.get("address"), 40))),
    ...optional("range", oneOf(RANGES, params.get("range"))),
    ...(rows === PAIR_PAGE_SIZE ? {} : { rows }),
  };
  return Object.keys(view).length === 0 ? null : view;
};

const writePairView = (params: URLSearchParams, view: PairViewQuery | undefined): void => {
  if (view === undefined) return;
  if (view.direction !== undefined) params.set("direction", view.direction);
  if (view.kind !== undefined) params.set("kind", view.kind);
  if (view.status !== undefined) params.set("status", view.status);
  if (view.address !== undefined && view.address !== "") params.set("address", view.address);
  if (view.range !== undefined) params.set("range", view.range);
  if (view.rows !== undefined && view.rows !== PAIR_PAGE_SIZE) params.set("rows", String(view.rows));
};

/** The history scan depth: a positive multiple of the default, at most 100 times it. */
const scanBlocksOf = (text: string | null): bigint | null => {
  if (text === null || !/^[0-9]{1,12}$/.test(text)) return null;
  const blocks = BigInt(text);
  if (blocks <= DEFAULT_MAXIMUM_BLOCKS || blocks % DEFAULT_MAXIMUM_BLOCKS !== 0n) return null;
  return blocks > DEFAULT_MAXIMUM_BLOCKS * 100n ? DEFAULT_MAXIMUM_BLOCKS * 100n : blocks;
};

const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]?: V }));
const nonEmpty = (value: string | undefined): string | undefined => (value === "" ? undefined : value);

// ---- the overlay: the open dialog and its form --------------------------------------------------------------------
//
// Every value here is a public transaction parameter (amount, receiver, call target and data, tip settings) or a
// view choice. Nothing secret and nothing signed ever goes in the address: the wallet signs only after the review step,
// and a form filled from a link still has to pass that review. Values are checked against their shape on the way in,
// and a field that came from the link is flagged in the form (see `linkedFields`).

/** The dialogs that the address can open. */
export type DialogName = "bridge" | "wrap" | "message" | "settings";
const DIALOGS = ["bridge", "wrap", "message", "settings"] as const;

/** The tip settings of the bridge form that differ from the defaults. */
export type TipQuery = {
  readonly mode?: "percentage" | "fixed" | "gas-multiplier" | "none";
  readonly percentText?: string;
  readonly fixedText?: string;
  readonly marginPercentText?: string;
  readonly gasMultiplierText?: string;
  readonly ceilingGweiText?: string;
  /** The cap on the automatic fee, in percent of the amount; absent takes the one in Settings. */
  readonly capPercentText?: string;
  readonly senderPriceText?: string;
  readonly routerText?: string;
  readonly payoutNative?: true;
};

/** The fields of the bridge and wrap form that differ from the defaults. */
export type BridgeQuery = {
  /** `<side>:<token address>` or `<side>:native` (a link writes the native coin as the zero address). */
  readonly token?: string;
  readonly amount?: string;
  readonly receiver?: string;
  readonly mode?: "plain" | "call";
  readonly data?: string;
  readonly gasLimit?: string;
  readonly callTarget?: string;
  readonly callData?: string;
  readonly tip?: TipQuery;
};

/** The fields of the message form that differ from the defaults. */
export type MessageQuery = {
  readonly chain?: "first" | "second";
  readonly target?: string;
  readonly data?: string;
  readonly gas?: string;
};

/** The dialog that is open, with its form. */
export type Overlay = { readonly dialog: DialogName | null; readonly bridge: BridgeQuery; readonly message: MessageQuery };

/** No dialog open. */
export const NO_OVERLAY: Overlay = Object.freeze({ dialog: null, bridge: Object.freeze({}), message: Object.freeze({}) });

const MAXIMUM_DATA_DIGITS = 24_000;
const TOKEN_CHOICE = /^(first|second):(native|0x[0-9a-fA-F]{40})$/;
/** The zero address: how a link names a chain's native coin (owner, quotes 101–102). */
export const NATIVE_IN_LINK = "0x0000000000000000000000000000000000000000";

/**
 * A token choice as a link writes it, read into the page's own form: `<side>:<address>`, where the zero address is the
 * native coin (the page keeps `<side>:native`). "native" alone, and the older `<side>:native`, are read too; the shell
 * then rewrites the address to the zero-address form ({@link linkNamesNativeOldWay}).
 *
 * @param text The `bridge.token` value, or null.
 * @param dir The direction the link asks for, which says the side of a bare "native".
 */
const tokenChoiceOf = (text: string | null, dir: string | null): string | undefined => {
  if (text === null) return undefined;
  if (text.toLowerCase() === "native") return `${dir === "second-to-first" ? "second" : "first"}:native`;
  if (!TOKEN_CHOICE.test(text)) return undefined;
  const [side, address] = text.split(":") as [string, string];
  return address.toLowerCase() === NATIVE_IN_LINK ? `${side}:native` : text;
};

/** The token choice as a link writes it: the native coin as the zero address on its chain. */
const tokenChoiceInLink = (choice: string): string => (choice.endsWith(":native") ? `${choice.slice(0, -"native".length)}${NATIVE_IN_LINK}` : choice);

/**
 * Whether an address names the native coin the older way ("native" rather than the zero address), so the shell
 * rewrites it in place.
 *
 * @param hash The address's hash.
 */
export const linkNamesNativeOldWay = (hash: string): boolean => /[?&]bridge\.token=([a-z]+(:|%3A))?native(&|$)/i.test(hash);
const BRIDGE_KEYS = ["token", "amount", "receiver", "mode", "data", "gas", "callTarget", "callData"] as const;
const TIP_KEYS = ["mode", "percent", "fixed", "margin", "gas", "ceiling", "cap", "price", "router", "native"] as const;
const MESSAGE_KEYS = ["from", "target", "data", "gas"] as const;

/** Whether a query parameter belongs to the overlay rather than to the route. */
export const isOverlayKey = (name: string): boolean => name === "dialog" || name.startsWith("bridge.") || name.startsWith("tip.") || name.startsWith("msg.");

const tipOf = (params: URLSearchParams): TipQuery => {
  const get = (key: (typeof TIP_KEYS)[number]): string | null => params.get(`tip.${key}`);
  return {
    ...optional("mode", oneOf(["percentage", "fixed", "gas-multiplier", "none"] as const, get("mode"))),
    ...optional("percentText", decimalText(get("percent"))),
    ...optional("fixedText", decimalText(get("fixed"))),
    ...optional("marginPercentText", decimalText(get("margin"))),
    ...optional("gasMultiplierText", decimalText(get("gas"))),
    ...optional("ceilingGweiText", decimalText(get("ceiling"))),
    ...optional("capPercentText", decimalText(get("cap"))),
    ...optional("senderPriceText", decimalText(get("price"))),
    ...optional("routerText", hexText(get("router"), 40)),
    ...(get("native") === "1" ? { payoutNative: true as const } : {}),
  };
};

const bridgeOf = (params: URLSearchParams): BridgeQuery => {
  const get = (key: (typeof BRIDGE_KEYS)[number]): string | null => params.get(`bridge.${key}`);
  const token = get("token");
  const tip = tipOf(params);
  return {
    ...optional("token", tokenChoiceOf(token, params.get("dir"))),
    // A bare `amount` is read too: people type it by hand (the owner did).
    ...optional("amount", decimalText(get("amount") ?? params.get("amount"))),
    ...optional("receiver", hexText(get("receiver"), 40)),
    ...optional("mode", oneOf(["plain", "call"] as const, get("mode"))),
    ...optional("data", hexText(get("data"), MAXIMUM_DATA_DIGITS)),
    ...optional("gasLimit", digitsText(get("gas"))),
    ...optional("callTarget", hexText(get("callTarget"), 40)),
    ...optional("callData", hexText(get("callData"), MAXIMUM_DATA_DIGITS)),
    ...(Object.keys(tip).length === 0 ? {} : { tip }),
  };
};

const messageOf = (params: URLSearchParams): MessageQuery => {
  const get = (key: (typeof MESSAGE_KEYS)[number]): string | null => params.get(`msg.${key}`);
  return {
    ...optional("chain", oneOf(["first", "second"] as const, get("from"))),
    ...optional("target", hexText(get("target"), 40)),
    ...optional("data", hexText(get("data"), MAXIMUM_DATA_DIGITS)),
    ...optional("gas", digitsText(get("gas"))),
  };
};

/**
 * Reads the open dialog and its form from the query of the hash. A form's fields are read only for that dialog.
 *
 * @param hash The `location.hash` text, with or without the `#`.
 */
export const parseOverlay = (hash: string): Overlay => {
  const query = hash.replace(/^#/, "").split("?")[1] ?? "";
  const params = new URLSearchParams(query);
  const dialog = oneOf(DIALOGS, params.get("dialog")) ?? null;
  if (dialog === null) return NO_OVERLAY;
  return {
    dialog,
    bridge: dialog === "bridge" || dialog === "wrap" ? bridgeOf(params) : {},
    message: dialog === "message" ? messageOf(params) : {},
  };
};

/** Writes the bridge and wrap form's fields that differ from the defaults (`bridge.*`, `tip.*`). */
const writeBridge = (params: URLSearchParams, bridge: BridgeQuery): void => {
  const { token, amount, receiver, mode, data, gasLimit, callTarget, callData, tip } = bridge;
  const set = (key: (typeof BRIDGE_KEYS)[number], value: string | undefined): void => {
    if (value !== undefined) params.set(`bridge.${key}`, value);
  };
  set("token", token === undefined ? undefined : tokenChoiceInLink(token));
  set("amount", amount);
  set("receiver", receiver);
  set("mode", mode);
  set("data", data);
  set("gas", gasLimit);
  set("callTarget", callTarget);
  set("callData", callData);
  if (tip !== undefined) {
    const setTip = (key: (typeof TIP_KEYS)[number], value: string | undefined): void => {
      if (value !== undefined) params.set(`tip.${key}`, value);
    };
    setTip("mode", tip.mode);
    setTip("percent", tip.percentText);
    setTip("fixed", tip.fixedText);
    setTip("margin", tip.marginPercentText);
    setTip("gas", tip.gasMultiplierText);
    setTip("ceiling", tip.ceilingGweiText);
    setTip("cap", tip.capPercentText);
    setTip("price", tip.senderPriceText);
    setTip("router", tip.routerText);
    setTip("native", tip.payoutNative === true ? "1" : undefined);
  }
};

const writeOverlay = (params: URLSearchParams, overlay: Overlay): void => {
  if (overlay.dialog === null) return;
  params.set("dialog", overlay.dialog);
  if (overlay.dialog === "bridge" || overlay.dialog === "wrap") writeBridge(params, overlay.bridge);
  if (overlay.dialog === "message") {
    const { chain, target, data, gas } = overlay.message;
    if (chain !== undefined) params.set("msg.from", chain);
    if (target !== undefined) params.set("msg.target", target);
    if (data !== undefined) params.set("msg.data", data);
    if (gas !== undefined) params.set("msg.gas", gas);
  }
};

/** The page's whole place: the view and the dialog over it. */
export type PageLocation = { readonly route: Route; readonly overlay: Overlay };

/**
 * Reads the view and the dialog from the hash.
 *
 * @param hash The `location.hash` text, with or without the `#`.
 */
export const parseLocation = (hash: string): PageLocation => ({ route: parseRoute(hash), overlay: parseOverlay(hash) });

/**
 * Writes the hash of a view with a dialog over it. The dialog's parameters follow the view's own.
 *
 * @param location The view and the dialog.
 */
export const formatLocation = ({ route, overlay }: PageLocation): string => {
  const base = formatRoute(route);
  const params = new URLSearchParams();
  writeOverlay(params, overlay);
  const query = params.toString();
  if (query === "") return base;
  return `${base}${base.includes("?") ? "&" : "?"}${query}`;
};

/**
 * The fields of a form that came from the address and can move funds somewhere the user did not choose: the receiver,
 * the call target and data, the router, the message target and data. The form names them so the user checks them.
 *
 * @param overlay The dialog as the link opened it.
 * @param account The connected account; a receiver equal to it is not flagged.
 */
/**
 * The fields of a bridge-screen link that need the user's attention: everything it filled except the route, the token
 * and the amount, which may prefill silently (security review of the bridge screen).
 *
 * @param form The form as the link carried it.
 * @param account The connected account; a receiver equal to it is not flagged.
 */
export const bridgeLinkedFields = (form: BridgeQuery, account: string | null): readonly string[] =>
  linkedFields({ ...NO_OVERLAY, dialog: "bridge", bridge: form }, account).filter((field) => field !== "token" && field !== "amount");

export const linkedFields = (overlay: Overlay, account: string | null): readonly string[] => {
  // Every field that moves funds, decides where they go, or changes what the sender pays is named; only the user's
  // own account as the receiver is left out.
  const fields: string[] = [];
  const { bridge, message } = overlay;
  const tip = bridge.tip ?? {};
  const named: ReadonlyArray<readonly [string | true | undefined, string]> = [
    [bridge.token, "token"],
    [bridge.amount, "amount"],
    [bridge.mode, "kind of transfer"],
    [bridge.receiver !== undefined && bridge.receiver.toLowerCase() === account?.toLowerCase() ? undefined : bridge.receiver, "receiver"],
    [bridge.callTarget, "call target"],
    [bridge.callData, "call data"],
    [bridge.data, "data for the receiver"],
    [bridge.gasLimit, "gas for the call"],
    [tip.mode, "tip kind"],
    [tip.percentText, "tip percentage"],
    [tip.fixedText, "fixed tip"],
    [tip.marginPercentText, "tip margin"],
    [tip.gasMultiplierText, "tip gas multiplier"],
    [tip.ceilingGweiText, "gas price ceiling"],
    [tip.capPercentText, "automatic fee cap"],
    [tip.senderPriceText, "sender gas price"],
    [tip.routerText, "relay router"],
    [tip.payoutNative, "tip paid in the native coin"],
    [message.target, "target contract"],
    [message.data, "message data"],
    [message.gas, "gas for the call"],
  ];
  for (const [value, label] of named) if (value !== undefined && value !== "") fields.push(label);
  return fields;
};
