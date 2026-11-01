/**
 * Explore (owner: "explorer should help you explore every data aspect"; mockups explore-map.html and explore.html):
 * the orange search band that takes any identifier, a browse list with live counts, then the live ring map, four
 * numbers, the light clients, the latest transfers and the services. Each kind has its own page (see ExplorePages).
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import type { FeedItem, PairConfig } from "@terminal/model/types";
import { formatLocation, formatRoute, NO_OVERLAY, type ExplorePage, type Route } from "../app/route";
import { useDeliveryCost, useFeed, useHeads, usePriorityFee, useTokens } from "../app/queries";
import { useServices } from "../app/services";
import type { ProbeKind } from "../app/service-probe";
import { useServiceProbe } from "../app/use-service-probe";
import { relativeTime } from "../bridge/activity-model";
import { amountText, chainsFor } from "../bridge/bridge-model";
import { Chevron, SearchIcon } from "../bridge/icons";
import { Num } from "../bridge/Num";
import { TokenIcon } from "../bridge/TokenIcon";
import { loadImageServer } from "../bridge/image-server";
import { iconSubjectOf, iconUrl } from "../bridge/image-source";
import { priceNumber, type PriceQuote } from "../bridge/price-oracle";
import { DEFAULT_GAS_LEVEL, type CostInput } from "@zk-bridge/shared";
import { usePrices } from "../bridge/use-prices";
import { durationText, exploreNumbers, lightClientCards, statusWord } from "./explore-model";
import { ExplorePageView } from "./ExplorePages";
import { InFlightOrbits } from "./InFlightOrbits";
import { dayStartOf, orbitTracks, proofCoversWith, type ProofReach } from "./orbit-model";
import { readLatestProof } from "../views/proof-panel-model";
import type { ProofDirection } from "@zk-bridge/shared";
import { orbitSample, SAMPLE_TICK } from "./orbit-sample";
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
          <InFlight data={data} />
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

/** One destination's delivery cost inputs (fee-rules' CostInput at the default, Normal, level), or null while any is unknown. */
const useCostInput = (chainId: number, prices: ReadonlyMap<string, PriceQuote | null> | undefined, live: boolean): CostInput | null => {
  const report = useDeliveryCost(chainId, { enabled: true }).data;
  const priority = usePriorityFee(chainId, { enabled: live }).data;
  const native = prices?.get(`native:${chainId}`) ?? null;
  if (report === undefined || report.baseFee.wei === null || native === null) return null;
  const kind = report.kinds.token;
  const gas = kind.p90Gas ?? kind.averageGas ?? kind.defaultGas;
  return { gasUsed: BigInt(gas), baseFeeWei: BigInt(report.baseFee.wei), priorityFeeWei: priority ?? 0n, nativePriceE18: native.usdE18, level: DEFAULT_GAS_LEVEL };
};

/**
 * The transfers in flight, per status, on the Explore polling (useFeed's interval); the delivered counts of the last
 * 24 hours and 7 days from the indexer's aggregate; each destination's delivery cost for the fee estimates. With the
 * sample data, a stream of sample transfers that moves in batches like the chain is added so the orbits have planets.
 */
/**
 * How far the latest valid proof of each direction reaches, as a time: the source chain's beacon genesis plus the
 * proof's new slot × seconds per slot. The proof is read as the message page's proof panel reads it (the msgboard
 * indexer, else the msgboard node); the genesis comes from the indexer's stored heads.
 */
const useProofReach = (enabled: boolean, heads: ExploreData["heads"]): { readonly reach: ProofReach; readonly fetching: number } => {
  const services = useServices();
  const { pair, explore } = services;
  const clocks = useQuery({ queryKey: ["explore", "beacon-clocks"], queryFn: () => explore.beaconClocks(), enabled, refetchInterval: 300_000 });
  const read = (direction: ProofDirection) => {
    const destination = direction === "first-to-second" ? pair.second : pair.first;
    const headSlot = heads.find((head) => head.side === (direction === "first-to-second" ? "second" : "first"))?.storedHeadSlot ?? null;
    return {
      queryKey: ["latest-proof", pair.id, direction, headSlot?.toString() ?? "unknown"],
      queryFn: () => readLatestProof({ endpoints: services.endpoints(), pair: pair.id, direction, headSlot, boardChainId: destination.chainId, transport: services.transport }),
      enabled,
      refetchInterval: 15_000,
    };
  };
  const out = useQuery(read("first-to-second"));
  const back = useQuery(read("second-to-first"));
  const reach = useMemo(() => {
    const reach: Partial<Record<ProofDirection, number>> = {};
    for (const [direction, reading, source] of [
      ["first-to-second", out.data, pair.first],
      ["second-to-first", back.data, pair.second],
    ] as const) {
      const clock = clocks.data?.find((row) => row.trackedChainId === source.chainId);
      if (reading?.kind === "found" && clock !== undefined) reach[direction] = clock.genesisTime + Number(reading.message.newSlot) * clock.secondsPerSlot;
    }
    return reach;
  }, [out.data, back.data, clocks.data, pair]);
  return { reach, fetching: [clocks, out, back].filter((query) => query.isFetching).length };
};

const InFlight = ({ data }: { readonly data: ExploreData }) => {
  const { pair, tokens, now } = data;
  const { configuration, explore } = useServices();
  const sample = configuration.dataMode === "fixture";
  const { reach, fetching: proofFetching } = useProofReach(!sample, data.heads);
  const dayStart = dayStartOf(now);
  const sent = useFeed(pair.id, { status: "sent" }, 200);
  const waiting = useFeed(pair.id, { status: "waiting_for_finality" }, 200);
  const covered = useFeed(pair.id, { status: "covered" }, 200);
  const delivered = useFeed(pair.id, { status: "delivered", sentAtOrAfter: dayStart - 7 * 86_400 }, 200);
  const aggregate = useQuery({ queryKey: ["explore", "delivered"], queryFn: () => explore.delivered(), refetchInterval: 60_000, enabled: !sample });
  const samples = useQuery({
    queryKey: ["explore", "orbit-sample", pair.id, tokens.length],
    queryFn: () => orbitSample(pair, tokens, Date.now() / 1000, now),
    enabled: sample,
    // The sample stream moves one event per tick; read it as often.
    refetchInterval: SAMPLE_TICK * 1000,
  });
  const priceQuery = usePrices(tokens);
  const prices = priceQuery.data;
  const firstCost = useCostInput(pair.first.chainId, prices, configuration.dataMode === "live");
  const secondCost = useCostInput(pair.second.chainId, prices, configuration.dataMode === "live");
  const tracks = useMemo(
    () =>
      orbitTracks({
        pair,
        inFlight: [...(sent.data?.items ?? []), ...(waiting.data?.items ?? []), ...(covered.data?.items ?? []), ...(samples.data?.inFlight ?? [])],
        delivered: [...(delivered.data?.items ?? []), ...(samples.data?.delivered ?? [])],
        now,
        deliveredCounts:
          aggregate.data === undefined
            ? null
            : new Map(aggregate.data.map((row) => [row.sourceChainId === pair.first.chainId ? ("first-to-second" as const) : ("second-to-first" as const), row])),
        proofCovers: proofCoversWith(reach),
        costOf: (chainId) => (chainId === pair.first.chainId ? firstCost : chainId === pair.second.chainId ? secondCost : null),
        iconOf: (token) => iconUrl(iconSubjectOf(token, pair), loadImageServer()),
        priceOf: (token) => {
          const quote = prices?.get(`${token.side}:${token.address}`) ?? null;
          return quote === null ? null : priceNumber(quote);
        },
      }),
    // Rebuilt when an answer changes, not on every render (`now` moves each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pair, sent.data, waiting.data, covered.data, delivered.data, aggregate.data, samples.data, prices, firstCost, secondCost, reach],
  );
  // Drawn once every list has answered, so the transfers already in flight appear in place, not out of the chains.
  const loading = sample ? samples.data === undefined : [sent, waiting, covered].some((query) => query.data === undefined && !query.isError);
  // Every request the loop is drawn from that is out now; a disabled query is never fetching, so the sample and live
  // modes each count only their own.
  const fetching = [sent, waiting, covered, delivered, aggregate, samples, priceQuery].filter((query) => query.isFetching).length + proofFetching;
  return <InFlightOrbits tracks={tracks} now={now} loading={loading} fetching={fetching} />;
};

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
            icon={item.token === null ? undefined : <TokenIcon subject={{ chainId: source.chainId, address: item.token.address }} symbol={item.token.symbol} isBridgedCopy={item.token.isBridgedCopy} size={28} decorative />}
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
export const ServiceRow = ({ name, url, kind }: { readonly name: string; readonly url: string | null; readonly kind: ProbeKind }) => {
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
      <XGroup title="Services" right={<a href={formatLocation({ route: { name: "explore" }, overlay: { ...NO_OVERLAY, dialog: "settings" } })}>Change in Settings</a>} />
      <ServiceRow name="Indexer" url={fixture ? null : (resolved?.indexerUrl?.value ?? configuration.indexerUrl)} kind={HEALTH} />
      <ServiceRow name="Prover" url={fixture ? null : (resolved?.backendUrl?.value ?? configuration.backendUrl)} kind={HEALTH} />
      <ServiceRow name="Archive" url={fixture ? null : (resolved?.archiveUrl?.value ?? configuration.archiveUrl)} kind={HEALTH} />
      <ServiceRow name={`RPC · ${shortName(pair.first.name)}`} url={fixture ? null : rpc(pair.first.chainId)} kind={{ kind: "rpc", chainId: pair.first.chainId }} />
      <ServiceRow name={`RPC · ${shortName(pair.second.name)}`} url={fixture ? null : rpc(pair.second.chainId)} kind={{ kind: "rpc", chainId: pair.second.chainId }} />
    </div>
  );
};
