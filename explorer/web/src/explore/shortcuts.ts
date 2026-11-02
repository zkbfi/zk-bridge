/**
 * The shortcut menu under Explore's empty search box. Owner: "yes, make the change and ship it to next. yes, you could
 * even do some sort of shortcut menu when the user focuses into the input". Each row is a real destination read from
 * what Explore has already loaded and carries a number; a row whose data is missing is left out.
 */
import type { FeedItem, LightClientHead, PairConfig, TokenInfo } from "@terminal/model/types";
import { formatRoute, type ExplorePage } from "../app/route";
import { relativeTime } from "../bridge/activity-model";
import { amountText, chainsFor } from "../bridge/bridge-model";
import { lightClientCards, type LightClientCard } from "./explore-model";
import type { ProofRow } from "./explore-source";

/** One row of the menu. `group` is the heading it sits under; `href` is where Enter opens. */
export type Shortcut = { readonly id: string; readonly group: string; readonly title: string; readonly sub: string; readonly href: string };

/** What the menu reads: the same data Explore's top loads. */
export type ShortcutData = {
  readonly pair: PairConfig;
  readonly now: number;
  readonly feed: readonly FeedItem[];
  readonly proofs: readonly ProofRow[];
  readonly tokens: readonly TokenInfo[];
  readonly heads: readonly LightClientHead[];
};

const page = (value: ExplorePage): string => formatRoute({ name: "explore", page: value });

const latestTransfer = ({ pair, now, feed }: ShortcutData): readonly Shortcut[] => {
  const newest = feed.reduce<FeedItem | null>((best, item) => (best === null || item.sentAt > best.sentAt ? item : best), null);
  if (newest === null) return [];
  const { source } = chainsFor(pair, newest.direction);
  const title = newest.token === null || newest.amount === null ? "Message" : `${amountText(newest.amount, newest.token.decimals)} ${newest.token.symbol}`;
  return [{ id: "transfer", group: "Latest transfer", title, sub: relativeTime(newest.sentAt, now), href: page({ kind: "tx", chainId: source.chainId, id: newest.sourceTransactionHash }) }];
};

const latestProofs = ({ pair, now, proofs }: ShortcutData): readonly Shortcut[] =>
  [pair.second, pair.first].flatMap((holder) => {
    const newest = proofs.filter((proof) => proof.chainId === holder.chainId).reduce<ProofRow | null>((best, proof) => (best === null || proof.timestamp > best.timestamp ? proof : best), null);
    if (newest === null) return [];
    const checked = holder === pair.second ? pair.first : pair.second;
    return [{ id: `proof:${holder.chainId}`, group: "Latest proof", title: `Proof #${newest.number}`, sub: `${checked.name} → ${holder.name} · ${relativeTime(newest.timestamp, now)}`, href: page({ kind: "proof", chainId: holder.chainId, id: String(newest.number) }) }];
  });

const lightClients = ({ pair, now, heads }: ShortcutData): readonly Shortcut[] =>
  lightClientCards(heads, pair).flatMap((card: LightClientCard) =>
    card.verifiedSlot === null ? [] : [{ id: `client:${card.holderChainId}`, group: "Light clients", title: card.title, sub: `slot ${card.verifiedSlot.toLocaleString("en-US")} · ${card.lastUpdateAt === null ? "never updated" : `last update ${relativeTime(card.lastUpdateAt, now)}`}`, href: page({ kind: "slot", id: String(card.verifiedSlot) }) }],
  );

const tokenLists = ({ pair, tokens }: ShortcutData): readonly Shortcut[] =>
  (["first", "second"] as const).flatMap((side) => {
    const symbols = tokens.filter((token) => token.side === side).map((token) => token.symbol);
    return symbols.length === 0 ? [] : [{ id: `tokens:${side}`, group: "Tokens", title: pair[side].name, sub: `${symbols.join(", ")} · ${symbols.length} listed`, href: page({ kind: "browse", id: "tokens" }) }];
  });

/**
 * The menu's rows in display order. Latest release is left out: Explore's top does not load the release list, only its count.
 *
 * @param data What Explore's top has loaded.
 */
export const exploreShortcuts = (data: ShortcutData): readonly Shortcut[] => [...latestTransfer(data), ...latestProofs(data), ...lightClients(data), ...tokenLists(data)];
