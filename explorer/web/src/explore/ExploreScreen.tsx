/**
 * Explore (owner: "explorer should help you explore every data aspect"; mockups explore-map.html and explore.html):
 * the orange search band that takes any identifier, a browse list with live counts, then the live ring map, four
 * numbers, the light clients, the latest transfers and the services. Each kind has its own page (see ExplorePages).
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import type { FeedItem, PairConfig } from "@terminal/model/types";
import { formatRoute, type ExplorePage, type Route } from "../app/route";
import { useFeed, useHeads, useTokens } from "../app/queries";
import { useServices } from "../app/services";
import type { ProbeKind } from "../app/service-probe";
import { useServiceProbe } from "../app/use-service-probe";
import { relativeTime } from "../bridge/activity-model";
import { amountText, chainsFor } from "../bridge/bridge-model";
import { Chevron, SearchIcon } from "../bridge/icons";
import { Num } from "../bridge/Num";
import { TokenIcon } from "../bridge/TokenIcon";
import { durationText, exploreNumbers, lightClientCards, statusWord } from "./explore-model";
import { ExplorePageView } from "./ExplorePages";
import { Marked, RouteIcons, XGroup, XRow } from "./parts";
import { recognise, searchExplore } from "./search";
import "./explore.css";

/** Props of {@link ExploreScreen}. */
export type ExploreScreenProps = {
  readonly route: Extract<Route, { name: "explore" }>;
  /** Writes the search to the address in place. */
  readonly onRoute: (next: Route, mode?: "push" | "replace") => void;
};

const href = (page: ExplorePage): string => formatRoute({ name: "explore", page });

/** A chain name without its network suffix, for tight places: "PulseChain testnet v4" → "PulseChain". */
export const shortName = (name: string): string => name.split(" ")[0] ?? name;

/** The chain names of a pair by chain id. */
export const chainNamer = (pair: PairConfig) => (chainId: number): string => (pair.first.chainId === chainId ? pair.first.name : pair.second.chainId === chainId ? pair.second.name : String(chainId));

/** Explore: the top, or one of its pages. */
export const ExploreScreen = ({ route, onRoute }: ExploreScreenProps) => (route.page === undefined ? <ExploreTop route={route} onRoute={onRoute} /> : <ExplorePageView page={route.page} />);

const useExploreData = () => {
  const { pair, explore, now } = useServices();
  const proofs = useQuery({ queryKey: ["explore", "proofs"], queryFn: () => explore.proofs(), refetchInterval: 30_000 });
  const gates = useQuery({ queryKey: ["explore", "gates"], queryFn: () => explore.gates(), refetchInterval: 30_000 });
  const costs = useQuery({ queryKey: ["explore", "costs"], queryFn: () => explore.lightClientCosts(), refetchInterval: 60_000 });
  const counts = useQuery({ queryKey: ["explore", "counts"], queryFn: () => explore.counts(), refetchInterval: 60_000 });
  const feed = useFeed(pair.id, {}, 100);
  const tokens = useTokens(pair.id);
  const heads = useHeads(pair.id);
  return { pair, now: now(), proofs: proofs.data ?? [], gates: gates.data ?? [], costs: costs.data ?? [], counts: counts.data ?? null, feed: feed.data?.items ?? [], tokens: tokens.data ?? [], heads: heads.data ?? [] };
};

const ExploreTop = ({ route, onRoute }: ExploreScreenProps) => {
  const data = useExploreData();
  const [text, setText] = useState(route.q ?? "");
  useEffect(() => setText(route.q ?? ""), [route.q]);
  const recognised = recognise(text);
  const groups = text.trim() === "" ? [] : searchExplore(text, data);
  const names = chainNamer(data.pair);
  const set = (value: string): void => {
    setText(value);
    onRoute(value.trim() === "" ? { name: "explore" } : { name: "explore", q: value.trim() }, "replace");
  };
  return (
    <div className="zb-explore">
      <div className="zb-picker-search zb-xsearch" role="search">
        <SearchIcon />
        <input type="search" aria-label="Search Explore" placeholder="Tx, message, address, token, slot, block, proof…" spellCheck={false} autoComplete="off" value={text} onChange={(event) => set(event.target.value)} />
        <button type="button" className="zb-picker-close" aria-label="Clear the search" onClick={() => set("")}>
          ×
        </button>
      </div>
      <div className="zb-xkinds">
        <div className="zb-col">
          {recognised.kind === "empty" ? (
            <>
              <span className="zb-xkind">0x… 64 hex → tx or message</span>
              <span className="zb-xkind">0x… 40 hex → address</span>
              <span className="zb-xkind">numbers → slot, block, proof</span>
              <span className="zb-xkind">symbols → token</span>
              <span className="zb-xkind">bafy… → release</span>
            </>
          ) : (
            <span className="zb-xkind" data-on="true">
              {recognised.label}
              {recognised.kind === "unknown" ? "" : ` · ${groups.reduce((sum, group) => sum + group.items.length, 0)} found`}
            </span>
          )}
        </div>
      </div>
      {text.trim() !== "" ? (
        <div className="zb-col">
          {groups.length === 0 ? <p className="zb-small">Nothing on this pair matches. Paste a full hash, an address, a number or a token symbol.</p> : null}
          {groups.map((group) => (
            <section key={group.title}>
              <XGroup title={group.title} right={group.items.length} />
              {group.items.map((item) => (
                <XRow
                  key={item.href + item.title}
                  href={item.href}
                  icon={item.chains.length === 2 ? <RouteIcons from={item.chains[0]!} to={item.chains[1]!} names={names} /> : item.chains.length === 1 ? <TokenIcon subject={{ chainId: item.chains[0]! }} symbol={names(item.chains[0]!)} size={28} decorative /> : undefined}
                  title={<Marked text={item.title} match={item.match} />}
                  sub={<span className="zb-mono"><Marked text={item.sub} match={item.match} /></span>}
                />
              ))}
            </section>
          ))}
        </div>
      ) : (
        <>
          <Browse data={data} />
          <RingMap feed={data.feed} pair={data.pair} />
          <Numbers feed={data.feed} now={data.now} />
          <LightClients data={data} />
          <LatestTransfers feed={data.feed} pair={data.pair} now={data.now} />
          <Services pair={data.pair} />
        </>
      )}
    </div>
  );
};

type ExploreData = ReturnType<typeof useExploreData>;

const Browse = ({ data }: { readonly data: ExploreData }) => {
  const { pair, feed, proofs, tokens, gates, costs, counts } = data;
  const inFlight = exploreNumbers(feed, data.now).inFlight;
  const addresses = new Set([...feed.flatMap((item) => [item.sender.toLowerCase(), item.recipient.toLowerCase()]), ...proofs.map((proof) => proof.poster.toLowerCase())]).size;
  const contracts = [pair.first, pair.second].flatMap((chain) => Object.values(chain.contracts).filter((address) => address !== null)).length;
  const updates = costs.reduce((sum, row) => sum + row.updates, 0);
  const costWei = costs.reduce((sum, row) => sum + row.costWei, 0n);
  const perProof = updates === 0 ? null : costWei / BigInt(updates);
  const costChain = costs[0] === undefined ? null : costs[0].chainId === pair.first.chainId ? pair.first : pair.second;
  const open = gates.filter((gate) => gate.depositsOpen).length;
  const tiles: readonly { readonly n: React.ReactNode; readonly title: string; readonly sub: string; readonly kind: string }[] = [
    { n: feed.length, title: "Transfers & messages", sub: `latest ${feed.length} · ${inFlight} in flight`, kind: "transfers" },
    { n: proofs.length, title: "Proofs", sub: "light-client updates", kind: "proofs" },
    { n: tokens.length, title: "Tokens", sub: "bridged", kind: "tokens" },
    { n: addresses, title: "Addresses", sub: "senders, receivers, posters", kind: "addresses" },
    { n: contracts, title: "Contracts", sub: "on both chains", kind: "contracts" },
    { n: gates.length, title: "Gates & escrow", sub: `${open} open · ${counts?.escrowed ?? "—"} escrowed`, kind: "gates" },
    { n: perProof === null || costChain === null ? "—" : <Num text={amountText(perProof, 18)} />, title: "Costs", sub: perProof === null || costChain === null ? "per proof" : `${costChain.nativeSymbol} per proof · ${updates} posted`, kind: "costs" },
    { n: counts?.releases ?? "—", title: "Releases", sub: "signed, pinned CIDs", kind: "releases" },
  ];
  return (
    <div className="zb-col">
      <XGroup title="Browse" />
      <div className="zb-browse">
        {tiles.map((tile) => (
          <a key={tile.kind} className="zb-tile" href={tile.kind === "costs" ? href({ kind: "costs", id: "" }) : href({ kind: "browse", id: tile.kind })}>
            <span className="zb-tile-n">{tile.n}</span>
            <span className="zb-tile-t">{tile.title}</span>
            <span className="zb-tile-s">{tile.sub}</span>
            <span className="zb-tile-go">
              <Chevron dir="right" />
            </span>
          </a>
        ))}
      </div>
    </div>
  );
};

/** The live ring map: the two chains joined by the two halves of one ring; each transfer in flight runs along its lane. */
export const RingMap = ({ feed, pair }: { readonly feed: readonly FeedItem[]; readonly pair: PairConfig }) => {
  const flying = feed.filter((item) => item.status !== "delivered" && item.status !== "failed_call" && item.status !== "release_failed");
  const outbound = flying.filter((item) => item.direction === "first-to-second");
  const inbound = flying.filter((item) => item.direction === "second-to-first");
  const W = 390;
  const H = 300;
  const r = 130;
  const cx = W / 2;
  const cy = H / 2;
  const L = cx - r;
  const R = cx + r;
  const up = `M${L} ${cy} A ${r} ${r} 0 0 1 ${R} ${cy}`;
  const down = `M${R} ${cy} A ${r} ${r} 0 0 1 ${L} ${cy}`;
  const pulse = (path: string, index: number, count: number) => (
    <g key={`${path}-${index}`} className="zb-xpulse" style={{ offsetPath: `path('${path}')`, animationDelay: `${(-7 * index) / Math.max(1, count)}s` } as React.CSSProperties}>
      <line x1="-8" y1="0" x2="8" y2="0" stroke="var(--zb-plate)" strokeWidth="9" strokeLinecap="round" />
      <line x1="-8" y1="0" x2="8" y2="0" stroke="#ffffff" strokeWidth="3.5" strokeLinecap="round" />
    </g>
  );
  return (
    <section className="zb-xmap" aria-label={`${outbound.length} in flight to ${pair.second.name}, ${inbound.length} to ${pair.first.name}`}>
      <div className="zb-xmap-in">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden="true">
        <path d={up} fill="none" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="4" />
        <path d={down} fill="none" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="4" />
        {outbound.map((_, index) => pulse(up, index, outbound.length))}
        {inbound.map((_, index) => pulse(down, index, inbound.length))}
        <text x={cx} y={cy - 6} textAnchor="middle" fill="#ffffff" fontWeight="700" className="zb-xmap-count">{`${outbound.length} → ${shortName(pair.second.name)}`}</text>
        <text x={cx} y={cy + 20} textAnchor="middle" fill="#ffffff" fontWeight="700" className="zb-xmap-count">{`${inbound.length} → ${shortName(pair.first.name)}`}</text>
      </svg>
      <span className="zb-xmap-dot" style={{ left: `${(L / W) * 100}%` }}>
        <TokenIcon subject={{ chainId: pair.first.chainId }} symbol={pair.first.name} size={40} surface="accent" decorative />
        <small>{shortName(pair.first.name)}</small>
      </span>
      <span className="zb-xmap-dot" style={{ left: `${(R / W) * 100}%` }}>
        <TokenIcon subject={{ chainId: pair.second.chainId }} symbol={pair.second.name} size={40} surface="accent" decorative />
        <small>{shortName(pair.second.name)}</small>
      </span>
      </div>
    </section>
  );
};

const Numbers = ({ feed, now }: { readonly feed: readonly FeedItem[]; readonly now: number }) => {
  const numbers = exploreNumbers(feed, now);
  return (
    <div className="zb-xstats">
      <div className="zb-xstat">
        <span>Volume, 24 h</span>
        <b title="Needs a price; testnets have none">—</b>
      </div>
      <div className="zb-xstat">
        <span>Transfers, 24 h</span>
        <b>{numbers.transfers24h}</b>
      </div>
      <div className="zb-xstat">
        <span>Median time</span>
        <b>{numbers.medianSeconds === null ? "—" : durationText(numbers.medianSeconds)}</b>
      </div>
      <div className="zb-xstat">
        <span>Delivered by bots</span>
        <b title="The indexer does not say who delivered">—</b>
      </div>
    </div>
  );
};

const LightClients = ({ data }: { readonly data: ExploreData }) => {
  const cards = lightClientCards(data.heads, data.pair);
  return (
    <div className="zb-col">
      <XGroup title="Light clients" right={<a href="#/docs">How it's trustless</a>} />
      {cards.map((card) => (
        <a key={card.holderChainId} className="zb-xlc" href={card.verifiedSlot === null ? href({ kind: "browse", id: "proofs" }) : href({ kind: "slot", id: String(card.verifiedSlot) })}>
          <span className="zb-xlc-row">
            <TokenIcon subject={{ chainId: card.holderChainId }} symbol="" size={24} decorative />
            <b>{card.title}</b>
            <span className={card.behind ? "zb-xlc-lag zb-warn-text" : "zb-xlc-lag"}>{card.lagText}</span>
          </span>
          <span className="zb-xlc-bar" aria-hidden="true">
            <span style={{ width: `${card.fill * 100}%` }} />
          </span>
          <span className="zb-xlc-row zb-small">
            {card.verifiedSlot === null ? "Nothing verified yet" : `Verified up to slot ${card.verifiedSlot.toLocaleString("en-US")}`}
            <span className="zb-xlc-lag">{card.lastUpdateAt === null ? "never updated" : `updated ${relativeTime(card.lastUpdateAt, data.now)}`}</span>
          </span>
        </a>
      ))}
    </div>
  );
};

const LatestTransfers = ({ feed, pair, now }: { readonly feed: readonly FeedItem[]; readonly pair: PairConfig; readonly now: number }) => {
  const names = chainNamer(pair);
  return (
    <div className="zb-col">
      <XGroup title="Latest transfers" right={<a href={href({ kind: "browse", id: "transfers" })}>All</a>} />
      {feed.length === 0 ? <p className="zb-small">No transfers yet on this pair.</p> : null}
      {feed.slice(0, 8).map((item) => {
        const { source, destination } = chainsFor(pair, item.direction);
        return (
          <XRow
            key={item.id}
            href={href({ kind: "tx", chainId: source.chainId, id: item.sourceTransactionHash })}
            icon={item.token === null ? undefined : <TokenIcon subject={{ chainId: source.chainId, address: item.token.address }} symbol={item.token.symbol} size={28} decorative />}
            title={item.token === null || item.amount === null ? "Message" : <><Num text={amountText(item.amount, item.token.decimals)} /> {item.token.symbol}</>}
            sub={<><RouteIcons from={source.chainId} to={destination.chainId} names={names} /> {relativeTime(item.sentAt, now)}</>}
            status={statusWord(item.status)}
          />
        );
      })}
    </div>
  );
};

/** One outside service: a dot (green up, red down, grey not set or checking), its host and its latency. */
const ServiceRow = ({ name, url, kind }: { readonly name: string; readonly url: string | null; readonly kind: ProbeKind }) => {
  const state = useServiceProbe(url, kind);
  return (
    <div className="zb-xsvc">
      <span className="zb-xsvc-dot" data-ok={state.ok === null ? undefined : state.ok} aria-hidden="true" />
      <b>{name}</b>
      <span className="zb-mono zb-xsvc-url">{url === null ? "not set" : hostText(url)}</span>
      <span className="zb-xsvc-ms" title={state.ok === false ? state.reason : undefined}>
        {state.ok === null ? "—" : state.ok ? `${state.ms} ms` : "down"}
      </span>
    </div>
  );
};

const hostText = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "not a URL";
  }
};

const HEALTH: ProbeKind = { kind: "health" };

const Services = ({ pair }: { readonly pair: PairConfig }) => {
  const { configuration, connection } = useServices();
  const resolved = connection?.resolved();
  const rpc = (chainId: number): string | null => resolved?.rpcUrls[chainId]?.value ?? configuration.rpcUrls[chainId] ?? defaultRpcUrl(chainId);
  const fixture = configuration.dataMode === "fixture";
  return (
    <div className="zb-col">
      <XGroup title="Services" right={<a href="#/settings">Change in Settings</a>} />
      <ServiceRow name="Indexer" url={fixture ? null : (resolved?.indexerUrl?.value ?? configuration.indexerUrl)} kind={HEALTH} />
      <ServiceRow name="Prover" url={fixture ? null : (resolved?.backendUrl?.value ?? configuration.backendUrl)} kind={HEALTH} />
      <ServiceRow name="Archive" url={fixture ? null : (resolved?.archiveUrl?.value ?? configuration.archiveUrl)} kind={HEALTH} />
      <ServiceRow name={`RPC · ${shortName(pair.first.name)}`} url={fixture ? null : rpc(pair.first.chainId)} kind={{ kind: "rpc", chainId: pair.first.chainId }} />
      <ServiceRow name={`RPC · ${shortName(pair.second.name)}`} url={fixture ? null : rpc(pair.second.chainId)} kind={{ kind: "rpc", chainId: pair.second.chainId }} />
    </div>
  );
};
