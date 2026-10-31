/**
 * Every transfer in flight, at once (owner: "put the orbit visualization into the explore page"; mockup
 * design/ui/screens/inflight-orbits.html). One track per direction of the pair: the four steps of a transfer, each
 * transfer a planet circling the step it waits at. React draws the track once per data refresh; the planets move in
 * orbit-engine.ts. A list of the same transfers is always there for screen readers, and "Show as a list" shows it.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatRoute } from "../app/route";
import { leftText } from "../bridge/activity-model";
import { amountText } from "../bridge/bridge-model";
import { Num } from "../bridge/Num";
import { usdText } from "../bridge/price-oracle";
import { TokenIcon } from "../bridge/TokenIcon";
import { durationText } from "./explore-model";
import { EXIT_RADIUS, geometryFor, OrbitEngine, stepX, type OrbitGeometry } from "./orbit-engine";
import { ORBIT_STEPS, ORBIT_STEP_WORDS, type OrbitTrack, type Planet } from "./orbit-model";
import { XGroup } from "./parts";
import { shortChain } from "./tx-model";

/** Props of {@link InFlightOrbits}. */
export type InFlightOrbitsProps = {
  readonly tracks: readonly OrbitTrack[];
  /** Unix seconds now. */
  readonly now: number;
  /** Overrides the user's reduced-motion setting (tests). */
  readonly reducedMotion?: boolean;
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

/** The in-flight section: a heading with the list toggle, then a track per direction. */
export const InFlightOrbits = ({ tracks, now, reducedMotion }: InFlightOrbitsProps) => {
  const prefers = usePrefersReducedMotion();
  const reduced = reducedMotion ?? prefers;
  const [asList, setAsList] = useState(false);
  return (
    <div className="zb-col zb-orbs">
      <XGroup
        title="In flight"
        right={
          <button type="button" className="zb-orb-toggle" aria-pressed={asList} onClick={() => setAsList(!asList)}>
            {asList ? "Show as orbits" : "Show as a list"}
          </button>
        }
      />
      {tracks.map((track) => (
        <TrackView key={track.direction} track={track} now={now} reduced={reduced} asList={asList} />
      ))}
    </div>
  );
};

type Tip = { readonly planet: Planet; readonly x: number; readonly y: number };

const placeTip = (node: HTMLElement, x: number, y: number): void => {
  const width = node.offsetWidth || 240;
  const height = node.offsetHeight || 110;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, x + 14));
  const top = y + 14 + height > window.innerHeight - 8 ? Math.max(8, y - height - 14) : y + 14;
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
};

const TrackView = ({ track, now, reduced, asList }: { readonly track: OrbitTrack; readonly now: number; readonly reduced: boolean; readonly asList: boolean }) => {
  const box = useRef<HTMLDivElement>(null);
  const layer = useRef<SVGGElement>(null);
  const guides = useRef<SVGGElement>(null);
  const tipNode = useRef<HTMLDivElement>(null);
  const engine = useRef<OrbitEngine | null>(null);
  const [geometry, setGeometry] = useState<OrbitGeometry>(() => geometryFor(700));
  const [tip, setTip] = useState<Tip | null>(null);
  const nowRef = useRef(now);
  nowRef.current = now;
  const from = shortChain(track.from.name);
  const to = shortChain(track.to.name);

  useLayoutEffect(() => {
    const node = box.current;
    if (node === null) return;
    const measure = (): void => setGeometry((previous) => {
      const next = geometryFor(node.clientWidth);
      return next.width === previous.width ? previous : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (layer.current === null || guides.current === null) return;
    const created = new OrbitEngine({
      layer: layer.current,
      guides: guides.current,
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
    });
    engine.current = created;
    return () => {
      created.destroy();
      engine.current = null;
      setTip(null);
    };
    // The engine is rebuilt only when motion is switched; size and data reach it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  useEffect(() => engine.current?.setGeometry(geometry), [geometry]);
  useEffect(() => engine.current?.sync(track.drawn), [track.drawn, reduced]);

  useLayoutEffect(() => {
    if (tip !== null && tipNode.current !== null) placeTip(tipNode.current, tip.x, tip.y);
  }, [tip]);

  // The tooltip shows the planet's newest data after a refresh.
  const shown = tip === null ? null : (track.planets.find((planet) => planet.id === tip.planet.id) ?? tip.planet);
  const total = track.planets.length;
  const name = `${from} to ${to}: ${total} ${total === 1 ? "transfer" : "transfers"} in flight`;
  const labels = useMemo(() => ORBIT_STEPS.map((label, step) => ({ label, step, left: (stepX(geometry, step) / geometry.width) * 100 })), [geometry]);

  return (
    <section className="zb-orb" aria-label={`${from} to ${to}`}>
      <div className="zb-orb-head">
        <b>
          {from} → {to}
        </b>
        {` · ${total} in flight · ${track.deliveredToday} delivered today`}
      </div>
      <div ref={box} className="zb-orb-box" hidden={asList}>
        <svg className="zb-orb-svg" viewBox={`0 0 ${geometry.width} ${geometry.height}`} role="group" aria-label={name} data-reduced={reduced}>
          <line x1={geometry.x0} y1={geometry.y} x2={geometry.x1} y2={geometry.y} className="zb-orb-track" />
          <circle cx={geometry.exit} cy={geometry.y} r={EXIT_RADIUS} className="zb-orb-exit" />
          {/* The faint orbit paths; the step suns are drawn with the planets, by depth (orbit-engine.ts). */}
          <g ref={guides} />
          {track.overflow.map((extra, step) =>
            extra === 0 ? null : (
              <text key={step} x={stepX(geometry, step)} y={16} textAnchor="middle" className="zb-orb-more">
                +{extra}
              </text>
            ),
          )}
          <g ref={layer} />
        </svg>
        <div className="zb-orb-labels" aria-hidden="true">
          {labels.map(({ label, step, left }) => (
            <span key={label} style={{ left: `${left}%` }}>
              <b>{track.counts[step]}</b>
              {label}
            </span>
          ))}
        </div>
      </div>
      {total === 0 ? <p className="zb-small zb-orb-empty">Nothing in flight right now</p> : null}
      <ul className={asList ? "zb-orb-list" : "zb-visually-hidden"} aria-label={`${from} to ${to}, transfers in flight`}>
        {track.planets.map((planet) => (
          <li key={planet.id}>
            <a href={messageHref(planet)}>
              {planet.token === null ? null : <TokenIcon subject={{ chainId: planet.source.chainId, address: planet.token.address }} symbol={planet.token.symbol} size={22} decorative />}
              <span>{planetLabel(planet, now)}</span>
            </a>
          </li>
        ))}
      </ul>
      {shown === null || tip === null
        ? null
        : createPortal(
            <div ref={tipNode} className="zb-orb-tip" role="tooltip">
              <div className="zb-orb-tip-amt">
                {shown.token === null ? null : <TokenIcon subject={{ chainId: shown.source.chainId, address: shown.token.address }} symbol={shown.token.symbol} size={20} decorative />}
                <b>{shown.token === null || shown.amount === null ? "Message" : <><Num text={amountText(shown.amount, shown.token.decimals)} /> {shown.token.symbol}</>}</b>
                {shown.usd === null ? null : <span className="zb-orb-tip-muted">≈ ${usdText(shown.usd)}</span>}
              </div>
              <div>
                {from} → {to} · to <span className="zb-mono">{shortAddress(shown.recipient)}</span>
              </div>
              <div>
                <span className="zb-orb-tip-muted">At:</span> {ORBIT_STEPS[shown.step]} · {durationText(Math.max(0, now - shown.sentAt))} since sent
              </div>
              <div className="zb-orb-tip-eta">{leftWords(shown.leftSeconds).replace(/^./, (c) => c.toUpperCase())}</div>
            </div>,
            document.body,
          )}
    </section>
  );
};
