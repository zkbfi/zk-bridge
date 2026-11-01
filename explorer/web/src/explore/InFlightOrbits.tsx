/**
 * Every transfer in flight, at once (owner: "put the orbit visualization into the explore page"; mockup
 * design/ui/screens/inflight-orbits.html). One loop for the pair (owner: "have the dots flow in a circle. left to right
 * on top and right to left on the bottom"): the first chain at the left end, the second at the right, each once; the
 * top lane carries first → second, the bottom lane second → first, each through the four steps of a transfer, each
 * transfer a planet circling the step it waits at. React draws the loop once per data refresh; the planets move in
 * orbit-engine.ts. A list of the same transfers is always there for screen readers, and the list icon of the toggle
 * shows it. The middle of the loop counts the requests out now.
 */
import { forwardRef, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatRoute } from "../app/route";
import { leftText } from "../bridge/activity-model";
import { amountText } from "../bridge/bridge-model";
import { shortAmountText } from "../bridge/number";
import { Num } from "../bridge/Num";
import { usdText } from "../bridge/price-oracle";
import { TokenIcon } from "../bridge/TokenIcon";
import { ListIcon, OrbitIcon } from "../bridge/icons";
import { durationText } from "./explore-model";
import { geometryFor, loopPath, NODE_RADIUS, OrbitEngine, stepX, type OrbitGeometry } from "./orbit-engine";
import type { DirectionTiming } from "./explore-source";
import { ORBIT_STEPS, ORBIT_STEP_WORDS, stepSummary, type OrbitStep, type OrbitTrack, type Planet } from "./orbit-model";
import { XGroup } from "./parts";
import { shortChain } from "./tx-model";

/** Props of {@link InFlightOrbits}. */
export type InFlightOrbitsProps = {
  /** The pair's two tracks: first → second, then second → first. */
  readonly tracks: readonly OrbitTrack[];
  /** Unix seconds now. */
  readonly now: number;
  /** Overrides the user's reduced-motion setting (tests). */
  readonly reducedMotion?: boolean;
  /** True until every answer has arrived: nothing is drawn yet, so the first answer appears in place rather than emerging. */
  readonly loading?: boolean;
  /**
   * The requests behind the loop that are out now (owner: "whenever requests go out to update the orbit, that should
   * show, and then decrement down to zero when no new data is loading"). Shown in the middle of the loop while above zero.
   */
  readonly fetching?: number;
};

/** Whether the user asked for reduced motion, following changes. */
export const usePrefersReducedMotion = (): boolean => {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const change = (): void => setReduced(media.matches);
    media.addEventListener?.("change", change);
    return () => media.removeEventListener?.("change", change);
  }, []);
  return reduced;
};

/** A short address: 0x1234…abcd. */
const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

const amountOf = (planet: Planet): string => (planet.token === null || planet.amount === null ? "Message" : `${amountText(planet.amount, planet.token.decimals)} ${planet.token.symbol}`);

const leftWords = (seconds: number): string => (seconds <= 0 ? "any moment now" : `${leftText(seconds)} left`);

/** A planet's accessible name, and its line in the list. */
export const planetLabel = (planet: Planet, now: number): string =>
  [
    amountOf(planet) + (planet.usd === null ? "" : ` (about $${usdText(planet.usd)})`),
    `${shortChain(planet.source.name)} to ${shortChain(planet.destination.name)}`,
    `to ${shortAddress(planet.recipient)}`,
    ORBIT_STEP_WORDS[planet.step],
    `sent ${durationText(Math.max(0, now - planet.sentAt))} ago`,
    leftWords(planet.leftSeconds),
  ].join(", ");

const messageHref = (planet: Planet): string => formatRoute({ name: "message", messageId: planet.id });

type Tip = { readonly planet: Planet; readonly x: number; readonly y: number };

/** One lane's figures as a chain's tooltip shows them. */
export type ChainLaneTotals = {
  readonly inFlight: number;
  /** The dollar value in flight, of the transfers with a price; null when none has one. */
  readonly usd: number | null;
  readonly delivered24h: number;
  readonly delivered7d: number;
};

/** A chain's totals (owner: "the in and out counts relative to each one as well as the total delivered in the last 24h", "as well as 7d totals"). */
export type ChainTotals = {
  /** The lane that starts at this chain. */
  readonly out: ChainLaneTotals;
  /** The other lane, arriving here. */
  readonly in: ChainLaneTotals;
  readonly delivered24h: number;
  readonly delivered7d: number;
};

const laneTotals = (track: OrbitTrack | undefined): ChainLaneTotals => {
  const priced = (track?.planets ?? []).filter((planet) => planet.usd !== null);
  return {
    inFlight: track?.planets.length ?? 0,
    usd: priced.length === 0 ? null : priced.reduce((sum, planet) => sum + planet.usd!, 0),
    delivered24h: track?.delivered24h ?? 0,
    delivered7d: track?.delivered7d ?? 0,
  };
};

/**
 * The totals of the pair's first (0) or second (1) chain.
 *
 * @param tracks The pair's tracks: first → second, then second → first.
 * @param index The chain.
 */
export const chainTotals = (tracks: readonly OrbitTrack[], index: 0 | 1): ChainTotals => {
  const out = laneTotals(tracks[index]);
  const back = laneTotals(tracks[1 - index]);
  return { out, in: back, delivered24h: out.delivered24h + back.delivered24h, delivered7d: out.delivered7d + back.delivered7d };
};

const money = (usd: number | null): string => (usd === null ? "—" : `$${usdText(usd)}`);

const placeTip = (node: HTMLElement, x: number, y: number): void => {
  const width = node.offsetWidth || 240;
  const height = node.offsetHeight || 110;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, x + 14));
  const top = y + 14 + height > window.innerHeight - 8 ? Math.max(8, y - height - 14) : y + 14;
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
};

/** The in-flight section: a heading with the list toggle, a line per direction, then the loop (or the list). */
export const InFlightOrbits = ({ tracks, now, reducedMotion, loading = false, fetching = 0 }: InFlightOrbitsProps) => {
  const prefers = usePrefersReducedMotion();
  const reduced = reducedMotion ?? prefers;
  const [asList, setAsList] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const layers = [useRef<SVGGElement>(null), useRef<SVGGElement>(null)] as const;
  const guides = [useRef<SVGGElement>(null), useRef<SVGGElement>(null)] as const;
  const tipNode = useRef<HTMLDivElement>(null);
  const engine = useRef<OrbitEngine | null>(null);
  const [geometry, setGeometry] = useState<OrbitGeometry>(() => geometryFor(780));
  const [tip, setTip] = useState<Tip | null>(null);
  const [chainTip, setChainTip] = useState<{ readonly index: 0 | 1; readonly x: number; readonly y: number } | null>(null);
  const chainTipNode = useRef<HTMLDivElement>(null);
  const [sunTip, setSunTip] = useState<{ readonly lane: number; readonly step: number; readonly x: number; readonly y: number } | null>(null);
  const sunTipNode = useRef<HTMLDivElement>(null);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const nowRef = useRef(now);
  nowRef.current = now;
  const out = tracks[0];
  const back = tracks[1];

  useLayoutEffect(() => {
    const node = box.current;
    if (node === null) return;
    const measure = (): void =>
      setGeometry((previous) => {
        const next = geometryFor(node.clientWidth);
        return next.width === previous.width ? previous : next;
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const [top, bottom] = [layers[0].current, layers[1].current];
    const [topPaths, bottomPaths] = [guides[0].current, guides[1].current];
    if (top === null || bottom === null || topPaths === null || bottomPaths === null) return;
    const created = new OrbitEngine({
      lanes: [
        { layer: top, guides: topPaths },
        { layer: bottom, guides: bottomPaths },
      ],
      reduced,
      geometry,
      onTip: setTip,
      onTipMove: (x, y) => {
        if (tipNode.current !== null) placeTip(tipNode.current, x, y);
      },
      onOpen: (planet) => {
        window.location.hash = messageHref(planet);
      },
      label: (planet) => planetLabel(planet, nowRef.current),
      sunLabel: (lane, step) => {
        const track = tracksRef.current[lane];
        return `${ORBIT_STEPS[step]}, ${track === undefined ? "" : `${shortChain(track.from.name)} to ${shortChain(track.to.name)}`}: totals`;
      },
      onSunTip: setSunTip,
    });
    engine.current = created;
    return () => {
      created.destroy();
      engine.current = null;
      setTip(null);
      setSunTip(null);
    };
    // The engine is rebuilt only when motion is switched; size and data reach it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  const drawn = useMemo(() => tracks.flatMap((track) => track.drawn), [tracks]);
  const inFlightIds = useMemo(() => new Set<string>(tracks.flatMap((track) => track.planets.map((planet) => planet.id))), [tracks]);
  useEffect(() => engine.current?.setGeometry(geometry), [geometry]);
  useEffect(() => {
    if (!loading) engine.current?.sync(drawn, inFlightIds);
  }, [drawn, reduced, loading]);

  useLayoutEffect(() => {
    if (tip !== null && tipNode.current !== null) placeTip(tipNode.current, tip.x, tip.y);
  }, [tip]);
  useLayoutEffect(() => {
    if (chainTip !== null && chainTipNode.current !== null) placeTip(chainTipNode.current, chainTip.x, chainTip.y);
  }, [chainTip]);
  useLayoutEffect(() => {
    if (sunTip !== null && sunTipNode.current !== null) placeTip(sunTipNode.current, sunTip.x, sunTip.y);
  }, [sunTip]);

  if (out === undefined || back === undefined) return null;
  const first = out.from;
  const second = out.to;
  const all = tracks.flatMap((track) => track.planets);
  // The tooltip shows the planet's newest data after a refresh.
  const shown = tip === null ? null : (all.find((planet) => planet.id === tip.planet.id) ?? tip.planet);
  const total = all.length;
  const pct = (x: number, y: number) => ({ left: `${(x / geometry.width) * 100}%`, top: `${(y / geometry.height) * 100}%` });
  const middle = (geometry.a + geometry.b) / 2;

  return (
    <div className="zb-col zb-orbs">
      <XGroup
        title="In flight"
        right={
          // Two icons, one switch (owner: "a simple toggle with 2 icons"): the view shown is the one pressed.
          <div className="zb-orb-toggle" role="group" aria-label="View">
            <button type="button" aria-label="Show as orbits" title="Orbits" aria-pressed={!asList} onClick={() => setAsList(false)}>
              <OrbitIcon />
            </button>
            <button type="button" aria-label="Show as a list" title="List" aria-pressed={asList} onClick={() => setAsList(true)}>
              <ListIcon />
            </button>
          </div>
        }
      />
      <div ref={box} className="zb-orb-box" hidden={asList}>
        <svg className="zb-orb-svg" viewBox={`0 0 ${geometry.width} ${geometry.height}`} role="group" aria-label={`Transfers in flight between ${shortChain(first.name)} and ${shortChain(second.name)}: ${total}`} data-reduced={reduced}>
          <path d={loopPath(geometry)} className="zb-orb-track" />
          {/* Direction marks: right on the top lane, left on the bottom. */}
          {[
            [middle - 75, geometry.yTop, 1],
            [middle + 75, geometry.yBottom, -1],
          ].map(([x, y, d]) => (
            <path key={y} d={`M ${x! - 5 * d!} ${y! - 6} L ${x! + 5 * d!} ${y} L ${x! - 5 * d!} ${y! + 6}`} className="zb-orb-dir" />
          ))}
          {/* The chains at the ends: the first left, the second right. */}
          {[first, second].map((chain, index) => {
            const node = geometry.nodes[index]!;
            return (
              <Fragment key={chain.chainId}>
                <circle cx={node.x} cy={node.y} r={NODE_RADIUS} className="zb-orb-node" data-chain={chain.chainId} />
                <text x={node.x} y={node.y + 44} textAnchor="middle" className="zb-orb-node-name">
                  {shortChain(chain.name)}
                </text>
              </Fragment>
            );
          })}
          {tracks.map((track, index) => {
            const lane = geometry.lanes[index]!;
            return (
              <g key={track.direction} data-lane={index}>
                <g ref={guides[index]} />
                <g ref={layers[index]} />
                {ORBIT_STEPS.map((label, step) => (
                  <text key={label} x={stepX(lane, step)} y={index === 0 ? geometry.yTop - 78 : geometry.yBottom + 86} textAnchor="middle" className="zb-orb-label" style={{ fontSize: geometry.labelSize }} aria-hidden="true">
                    <tspan className="zb-orb-count">{track.counts[step]}</tspan>
                    <tspan x={stepX(lane, step)} dy={15}>
                      {label}
                    </tspan>
                  </text>
                ))}
              </g>
            );
          })}
        </svg>
        {[first, second].map((chain, index) => {
          const node = geometry.nodes[index]!;
          const totals = chainTotals(tracks, index as 0 | 1);
          const show = (target: HTMLElement): void => {
            const rect = target.getBoundingClientRect();
            setChainTip({ index: index as 0 | 1, x: rect.right, y: rect.bottom });
          };
          return (
            <button
              key={chain.chainId}
              type="button"
              className="zb-orb-chain"
              style={pct(node.x, node.y)}
              aria-label={`${shortChain(chain.name)} (${chain.nativeSymbol}): out ${totals.out.inFlight} in flight, in ${totals.in.inFlight} in flight; delivered ${totals.delivered24h} in the last 24 h, ${totals.delivered7d} in the last 7 days`}
              onPointerEnter={(event) => show(event.currentTarget)}
              onPointerLeave={() => setChainTip(null)}
              onFocus={(event) => show(event.currentTarget)}
              onBlur={() => setChainTip(null)}
              onClick={(event) => (chainTip?.index === index ? setChainTip(null) : show(event.currentTarget))}
            >
              <TokenIcon subject={{ chainId: chain.chainId }} symbol={chain.name} size={36} surface="accent" decorative />
            </button>
          );
        })}
        {/* The requests out now, counting down to zero; it fades once none is left. Silent to screen readers: it changes
            on every poll, and the list beside the loop already says what is in flight. */}
        <div className="zb-orb-loader" style={pct(middle, (geometry.yTop + geometry.yBottom) / 2)} data-on={fetching > 0} data-reduced={reduced} aria-hidden="true" title={`${fetching} ${fetching === 1 ? "request" : "requests"} loading`}>
          <span className="zb-orb-loader-ring" />
          <span className="zb-orb-loader-n">{fetching}</span>
        </div>
      </div>
      {total === 0 ? <p className="zb-small zb-orb-empty">Nothing in flight right now</p> : null}
      {tracks.map((track) => (
        <ul key={track.direction} className={asList ? "zb-orb-list" : "zb-visually-hidden"} aria-label={`${shortChain(track.from.name)} to ${shortChain(track.to.name)}, transfers in flight`}>
          {track.planets.map((planet) => (
            <li key={planet.id}>
              <a href={messageHref(planet)}>
                {planet.token === null ? null : <TokenIcon subject={{ chainId: planet.source.chainId, address: planet.token.address }} symbol={planet.token.symbol} isBridgedCopy={planet.token.isBridgedCopy} size={22} decorative />}
                <span>{planetLabel(planet, now)}</span>
              </a>
            </li>
          ))}
        </ul>
      ))}
      {chainTip === null
        ? null
        : createPortal(
            (() => {
              const chain = chainTip.index === 0 ? first : second;
              const totals = chainTotals(tracks, chainTip.index);
              return (
                <div ref={chainTipNode} className="zb-orb-tip" role="tooltip">
                  <div className="zb-orb-tip-amt">
                    <TokenIcon subject={{ chainId: chain.chainId }} symbol={chain.name} size={20} decorative />
                    <b>{shortChain(chain.name)}</b>
                    <span className="zb-orb-tip-muted">{chain.nativeSymbol}</span>
                  </div>
                  <table className="zb-orb-tip-table">
                    <thead>
                      <tr>
                        <th scope="col" />
                        <th scope="col">In flight</th>
                        <th scope="col">Value</th>
                        <th scope="col">24 h</th>
                        <th scope="col">7 d</th>
                      </tr>
                    </thead>
                    <tbody>
                      {([["Out", totals.out], ["In", totals.in]] as const).map(([name, lane]) => (
                        <tr key={name}>
                          <th scope="row">{name}</th>
                          <td>{lane.inFlight}</td>
                          <td>{money(lane.usd)}</td>
                          <td>{lane.delivered24h}</td>
                          <td>{lane.delivered7d}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="zb-orb-tip-steps">
                    Delivered: {totals.delivered24h} in the last 24 h · {totals.delivered7d} in the last 7 days
                  </div>
                  <ChainTiming out={tracks[chainTip.index]?.timing ?? null} back={tracks[1 - chainTip.index]?.timing ?? null} />
                </div>
              );
            })(),
            document.body,
          )}
      {sunTip === null || tracks[sunTip.lane] === undefined
        ? null
        : createPortal(<SunTip ref={sunTipNode} track={tracks[sunTip.lane]!} step={sunTip.step as OrbitStep} now={now} />, document.body)}
      {shown === null || tip === null
        ? null
        : createPortal(
            <div ref={tipNode} className="zb-orb-tip" role="tooltip">
              <div className="zb-orb-tip-amt">
                {shown.token === null ? null : <TokenIcon subject={{ chainId: shown.source.chainId, address: shown.token.address }} symbol={shown.token.symbol} isBridgedCopy={shown.token.isBridgedCopy} size={20} decorative />}
                <b>{shown.token === null || shown.amount === null ? "Message" : <><Num text={amountText(shown.amount, shown.token.decimals)} /> {shown.token.symbol}</>}</b>
                {shown.usd === null ? null : <span className="zb-orb-tip-muted">≈ ${usdText(shown.usd)}</span>}
              </div>
              <div className="zb-orb-tip-route">
                <TokenIcon subject={{ chainId: shown.source.chainId }} symbol={shown.source.name} size={14} decorative />
                {shortChain(shown.source.name)} →
                <TokenIcon subject={{ chainId: shown.destination.chainId }} symbol={shown.destination.name} size={14} decorative />
                {shortChain(shown.destination.name)} · to <span className="zb-mono">{shortAddress(shown.recipient)}</span>
              </div>
              <div>
                <span className="zb-orb-tip-muted">At:</span> {ORBIT_STEPS[shown.step]} · {durationText(Math.max(0, now - shown.sentAt))} since sent
              </div>
              <div className="zb-orb-tip-eta">{leftWords(shown.leftSeconds).replace(/^./, (c) => c.toUpperCase())}</div>
            </div>,
            document.body,
          )}
    </div>
  );
};

/**
 * A step's summary, on its sun (owner: "how many of each token and how much in fees each one is estimated to pay"; no
 * profit line: "realistically it only goes to the fee address. the runner is not compensated").
 */
export const SunTip = forwardRef<HTMLDivElement, { readonly track: OrbitTrack; readonly step: OrbitStep; readonly now: number }>(({ track, step, now }, ref) => {
  const summary = stepSummary(track, step, now);
  const est = summary.feesEstimated ? " est." : "";
  return (
    <div ref={ref} className="zb-orb-tip zb-orb-sun-tip" role="tooltip">
      <div className="zb-orb-tip-amt">
        <b>{ORBIT_STEPS[step]}</b>
        <span className="zb-orb-tip-muted">
          {shortChain(track.from.name)} → {shortChain(track.to.name)}
        </span>
      </div>
      <div>
        {summary.count} {summary.count === 1 ? "transfer" : "transfers"} · {money(summary.usd)}
      </div>
      {summary.tokens.length === 0 ? null : (
        <table className="zb-orb-tip-table">
          <thead>
            <tr>
              <th scope="col">Token</th>
              <th scope="col">Amount</th>
              <th scope="col">Value</th>
              <th scope="col">Fees{est}</th>
            </tr>
          </thead>
          <tbody>
            {summary.tokens.map((line) => (
              <tr key={line.key}>
                <th scope="row">
                  <span className="zb-orb-tip-tok">
                    {line.token === null ? null : <TokenIcon subject={{ chainId: track.from.chainId, address: line.token.address }} symbol={line.token.symbol} isBridgedCopy={line.token.isBridgedCopy} size={14} decorative />}
                    {line.count}× {line.token?.symbol ?? "message"}
                  </span>
                </th>
                <td>{line.token === null || line.amount === null ? "—" : <Num text={shortAmountText(line.amount, line.token.decimals)} />}</td>
                <td>{money(line.usd)}</td>
                <td>{money(line.feesUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {summary.waiting === null ? null : (
        <div className="zb-orb-tip-wait">
          Waiting here now: {durationText(summary.waiting.avg)} avg · {durationText(summary.waiting.median)} median · {durationText(summary.waiting.longest)} longest
          {summary.slower ? <span className="zb-orb-tip-eta"> · slower than usual</span> : null}
        </div>
      )}
      {summary.usual === null || summary.usual.median24h === null ? null : (
        <div className="zb-orb-tip-usual">
          Usual time at this step: {durationText(summary.usual.median24h)} median · {summary.usual.p9024h === null ? "—" : durationText(summary.usual.p9024h)} p90 (24 h)
          {summary.usual.median7d === null ? null : `; ${durationText(summary.usual.median7d)} median (7 d)`}
        </div>
      )}
      {/* The fees go to the fee address, not to whoever delivers (owner: "the runner is not compensated"). */}
      <div className="zb-orb-tip-fees">
        Fees{est} (paid to the fee address): {money(summary.feesUsd)} · cost to deliver all: {money(summary.costUsd)}
        {summary.costUsd === null ? null : <span className="zb-orb-tip-muted"> ({summary.count} × gas + one $0.025 proof)</span>}
      </div>
    </div>
  );
});
SunTip.displayName = "SunTip";

const seconds = (value: number | null): string => (value === null ? "—" : durationText(value));

/** A chain's "Sent → delivered" table (owner: "aggregate timing stats, time from sent transaction to delivered avg, median, etc"). */
export const ChainTiming = ({ out, back }: { readonly out: DirectionTiming | null; readonly back: DirectionTiming | null }) => {
  if (out === null && back === null) return null;
  const rows = [
    ["Out 24 h", out?.last24h],
    ["Out 7 d", out?.last7d],
    ["In 24 h", back?.last24h],
    ["In 7 d", back?.last7d],
  ] as const;
  return (
    <table className="zb-orb-tip-table" aria-label="Sent → delivered">
      <thead>
        <tr>
          <th scope="col">Sent → delivered</th>
          <th scope="col">avg</th>
          <th scope="col">median</th>
          <th scope="col">p90</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, window]) => (
          <tr key={name}>
            <th scope="row">{name}</th>
            <td>{seconds(window?.sentToDelivered.avg ?? null)}</td>
            <td>{seconds(window?.sentToDelivered.median ?? null)}</td>
            <td>{seconds(window?.sentToDelivered.p90 ?? null)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
