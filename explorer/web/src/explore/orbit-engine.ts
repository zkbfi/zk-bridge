/**
 * The in-flight orbits' drawing (mockup design/ui/screens/inflight-orbits.html): one loop for the pair, the first chain
 * at its left end and the second at its right; the top lane carries first → second left to right, the bottom lane
 * second → first right to left, so each chain appears once (owner: "have the dots flow in a circle. left to right on
 * top and right to left on the bottom").
 *
 * One engine draws both lanes' planets with one requestAnimationFrame loop, writing SVG attributes directly, so React
 * never re-renders per frame. At rest each step's planets crowd into a tilted orbit seen in depth (front bigger and
 * brighter, drawn back to front around the step's sun); hovering a step opens its orbit so the planets separate;
 * hovering or focusing a planet freezes its orbit. Every move is a glide: planets ease toward their slots, a step change
 * arcs away from the loop's centre, a delivered planet drifts into its destination chain and fades. With reduced
 * motion nothing animates: planets sit still on their rings and every change is drawn once. The loop stops while the
 * tab is hidden.
 */
import type { Direction } from "@terminal/model/types";
import type { Planet } from "./orbit-model";

/** A point in the SVG's units. */
export type Point = { readonly x: number; readonly y: number };

/** One lane of the loop. */
export type OrbitLane = {
  readonly direction: Direction;
  /** The lane's y. */
  readonly y: number;
  /** Step 0's x, and the signed distance between steps (positive left to right). */
  readonly x0: number;
  readonly dx: number;
  /** The destination chain's node, where delivered planets go. */
  readonly exit: Point;
  /** Away from the loop's centre: -1 up (top lane), 1 down (bottom lane). */
  readonly away: -1 | 1;
};

/** The loop in the SVG's units (one unit is about one CSS pixel on a phone; the mockup's 780 on a desktop). */
export type OrbitGeometry = {
  readonly width: number;
  readonly height: number;
  /** The lanes' ends. */
  readonly a: number;
  readonly b: number;
  readonly yTop: number;
  readonly yBottom: number;
  /** The rounded ends' radius: (yBottom − yTop) / 2. */
  readonly end: number;
  /** The step labels' size: 12, or 11 on a phone where the steps sit closer. */
  readonly labelSize: number;
  /** The chains' nodes: the first chain left, the second right. */
  readonly nodes: readonly [Point, Point];
  /** Top lane (first → second), bottom lane (second → first). */
  readonly lanes: readonly [OrbitLane, OrbitLane];
};

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

/**
 * The loop for a width in CSS pixels. From 740 px it is the mockup's loop (W 780, H 440, A 170, B 610, YT 130, YB 310).
 * Narrower, the SVG's units follow the pixels so planets keep their size, and the horizontal room (the chains' margins
 * and the rounded ends) shrinks instead.
 *
 * @param pixels The column's width.
 */
export const geometryFor = (pixels: number): OrbitGeometry => {
  const wide = (pixels || 780) >= 740;
  const width = wide ? 780 : Math.round(Math.max(340, pixels));
  const t = wide ? 1 : (width - 340) / (780 - 340);
  const end = wide ? 90 : Math.round(lerp(42, 90, t));
  const margin = wide ? 80 : Math.round(lerp(28, 80, t));
  const a = margin + end;
  const b = width - a;
  const yTop = 130;
  const yBottom = yTop + 2 * end;
  const yMiddle = (yTop + yBottom) / 2;
  const nodes: [Point, Point] = [
    { x: a - end, y: yMiddle },
    { x: b + end, y: yMiddle },
  ];
  const step = (b - a) / 3;
  return {
    width,
    height: yBottom + 130,
    a,
    b,
    yTop,
    yBottom,
    end,
    labelSize: width < 480 ? 11 : 12,
    nodes,
    lanes: [
      { direction: "first-to-second", y: yTop, x0: a, dx: step, exit: nodes[1], away: -1 },
      { direction: "second-to-first", y: yBottom, x0: b, dx: -step, exit: nodes[0], away: 1 },
    ],
  };
};

/** A step's x on a lane. */
export const stepX = (lane: OrbitLane, step: number): number => lane.x0 + step * lane.dx;

/** The loop's path: top lane, right end, bottom lane, left end. */
export const loopPath = (g: OrbitGeometry): string => `M ${g.a} ${g.yTop} H ${g.b} A ${g.end} ${g.end} 0 0 1 ${g.b} ${g.yBottom} H ${g.a} A ${g.end} ${g.end} 0 0 1 ${g.a} ${g.yTop}`;

/** The sun at each step and a chain's node. */
export const SUN_RADIUS = 15;
export const NODE_RADIUS = 24;

/** The first orbit's radius, the gap to each further orbit, and the planets on the first orbit (each further one holds as many more). */
const R0 = 34;
const RING = 20;
const PER = 6;
/** The delay between the starts of planets that move in one batch, in milliseconds. */
const STAGGER = 60;
/** How close (in units) the pointer must be to a step to open it. */
const HOVER_REACH = 70;

const SVG = "http://www.w3.org/2000/svg";

type Body = {
  planet: Planet;
  lane: number;
  g: SVGGElement;
  x: number;
  y: number;
  z: number;
  alpha: number;
  tx: number;
  ty: number;
  tz: number;
  moving: { readonly start: number; readonly span: number } | null;
  leaving: boolean;
};

/** One lane's state. */
type LaneState = {
  readonly layer: SVGGElement;
  readonly guides: SVGGElement;
  readonly suns: SVGCircleElement[];
  readonly paths: Map<string, SVGEllipseElement>;
  readonly phase: Map<string, number>;
  readonly open: number[];
  hover: number;
  frozen: number;
  order: string;
};

/** What the engine tells the page. */
export type OrbitEngineOptions = {
  /** Per lane (top, bottom): the group its planets and suns are drawn into by depth, and the group of its faint orbit paths behind it. */
  readonly lanes: readonly [{ readonly layer: SVGGElement; readonly guides: SVGGElement }, { readonly layer: SVGGElement; readonly guides: SVGGElement }];
  readonly reduced: boolean;
  readonly geometry: OrbitGeometry;
  /** Show the tooltip for a planet at a viewport point, or hide it (null). */
  readonly onTip: (tip: { readonly planet: Planet; readonly x: number; readonly y: number } | null) => void;
  /** Move the shown tooltip to a viewport point. */
  readonly onTipMove: (x: number, y: number) => void;
  /** Open a planet's message page. */
  readonly onOpen: (planet: Planet) => void;
  /** A planet's accessible name. */
  readonly label: (planet: Planet) => string;
  /** The frame scheduler (tests pass their own). */
  readonly frames?: { readonly request: (callback: (time: number) => void) => number; readonly cancel: (handle: number) => void };
  readonly document?: Document;
};

const element = <name extends keyof SVGElementTagNameMap>(tag: name, attributes: Readonly<Record<string, string | number>>): SVGElementTagNameMap[name] => {
  const node = document.createElementNS(SVG, tag) as SVGElementTagNameMap[name];
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};

const ease = (dt: number, tau: number): number => 1 - Math.exp(-dt / tau);

/** Engines made so far, for unique pattern ids. */
let engines = 0;

const laneOf = (planet: Planet): number => (planet.source.side === "first" ? 0 : 1);

/** The pair's loop of planets. */
export class OrbitEngine {
  private readonly bodies = new Map<string, Body>();
  private readonly options: OrbitEngineOptions;
  private readonly frames: NonNullable<OrbitEngineOptions["frames"]>;
  private readonly doc: Document;
  private geometry: OrbitGeometry;
  private readonly lanes: readonly LaneState[];
  private tipId: string | null = null;
  private lastPointer = "mouse";
  private handle: number | null = null;
  private last: number | null = null;
  private synced = false;
  private destroyed = false;
  private readonly cleanup: (() => void)[] = [];
  /** The token icons' shared patterns, by URL. */
  private readonly patterns = new Map<string, { readonly id: string; state: "loading" | "ok" | "failed" }>();
  private defs: SVGDefsElement | null = null;
  private readonly uid = `zb-orb-${(engines++).toString(36)}`;

  constructor(options: OrbitEngineOptions) {
    this.options = options;
    this.geometry = options.geometry;
    this.doc = options.document ?? document;
    this.frames = options.frames ?? {
      request: (callback) => (typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(callback) : window.setTimeout(() => callback(performance.now()), 16)),
      cancel: (handle) => (typeof window.cancelAnimationFrame === "function" ? window.cancelAnimationFrame(handle) : window.clearTimeout(handle)),
    };
    this.lanes = options.lanes.map(({ layer, guides }, index) => {
      const suns = [0, 1, 2, 3].map((step) => element("circle", { r: SUN_RADIUS, class: step === 0 ? "zb-orb-stop zb-orb-stop-first" : "zb-orb-stop", "data-sun": step, "data-lane": index }));
      layer.append(...suns);
      return { layer, guides, suns, paths: new Map(), phase: new Map(), open: [0, 0, 0, 0], hover: -1, frozen: -1, order: "" };
    });
    this.placeSuns();
    const svg = options.lanes[0].layer.ownerSVGElement;
    if (svg !== null) {
      const move = (event: PointerEvent): void => {
        const box = svg.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return;
        const x = ((event.clientX - box.left) / box.width) * this.geometry.width;
        const y = ((event.clientY - box.top) / box.height) * this.geometry.height;
        // The nearest lane by y, then the nearest step by x.
        const lane = Math.abs(y - this.geometry.yTop) < Math.abs(y - this.geometry.yBottom) ? 0 : 1;
        let best = -1;
        let distance = HOVER_REACH;
        for (let step = 0; step < 4; step++) {
          const d = Math.abs(x - stepX(this.geometry.lanes[lane]!, step));
          if (d < distance) [distance, best] = [d, step];
        }
        this.setHover(lane, best);
      };
      const leave = (): void => {
        for (const lane of this.lanes) lane.frozen = -1;
        this.setHover(0, -1);
        this.hideTip();
      };
      svg.addEventListener("pointermove", move);
      svg.addEventListener("pointerleave", leave);
      this.cleanup.push(() => svg.removeEventListener("pointermove", move), () => svg.removeEventListener("pointerleave", leave));
    }
    const visibility = (): void => (this.doc.hidden ? this.stop() : this.start());
    this.doc.addEventListener("visibilitychange", visibility);
    this.cleanup.push(() => this.doc.removeEventListener("visibilitychange", visibility));
  }

  /** Whether the loop is running (it never runs with reduced motion or while the tab is hidden). */
  get running(): boolean {
    return this.handle !== null;
  }

  /** Starts the loop (or, with reduced motion, draws once). */
  start(): void {
    if (this.destroyed) return;
    if (this.options.reduced) {
      this.drawStill();
      return;
    }
    if (this.handle !== null || this.doc.hidden) return;
    this.last = null;
    this.handle = this.frames.request(this.frame);
  }

  /** Stops the loop. */
  stop(): void {
    if (this.handle !== null) this.frames.cancel(this.handle);
    this.handle = null;
  }

  /** Removes everything the engine added. */
  destroy(): void {
    this.destroyed = true;
    this.stop();
    for (const undo of this.cleanup) undo();
    for (const body of this.bodies.values()) body.g.remove();
    this.bodies.clear();
    this.defs?.remove();
    this.patterns.clear();
    for (const lane of this.lanes) {
      for (const sun of lane.suns) sun.remove();
      for (const path of lane.paths.values()) path.remove();
      lane.paths.clear();
    }
  }

  private placeSuns(): void {
    this.lanes.forEach((lane, index) => {
      const geometry = this.geometry.lanes[index]!;
      lane.suns.forEach((sun, step) => {
        sun.setAttribute("cx", stepX(geometry, step).toFixed(1));
        sun.setAttribute("cy", String(geometry.y));
      });
    });
  }

  /** A new size. */
  setGeometry(geometry: OrbitGeometry): void {
    this.geometry = geometry;
    this.placeSuns();
    if (this.options.reduced) this.drawStill();
  }

  /**
   * Opens one step's orbit on a lane (-1 closes every orbit). Only the step under the pointer may be open or frozen:
   * every other lane loses its hover and its freeze (owner: moving between directions must close the one left).
   */
  setHover(lane: number, step: number): void {
    const changed = this.lanes.some((state, index) => state.hover !== (index === lane ? step : -1) || (index !== lane && state.frozen !== -1));
    if (!changed) return;
    this.lanes.forEach((state, index) => {
      state.hover = index === lane ? step : -1;
      if (index !== lane) state.frozen = -1;
    });
    if (this.options.reduced) this.drawStill();
  }


  /**
   * The planets to draw now (both lanes). New ones appear at their step (a new send enters from its lane's start), ones
   * whose step changed travel to it, and ones no longer listed leave into their destination chain.
   */
  sync(planets: readonly Planet[]): void {
    const now = performance.now();
    const first = !this.synced;
    this.synced = true;
    const listed = new Set<string>();
    const placed: Body[] = [];
    // A batch (a finality, a proof posting, a round of deliveries) moves as a wave: each mover starts 60 ms after the last.
    let wave = 0;
    for (const planet of planets) {
      listed.add(planet.id);
      const existing = this.bodies.get(planet.id);
      if (existing !== undefined) {
        if (existing.planet.step !== planet.step && !this.options.reduced) existing.moving = { start: now + STAGGER * wave++, span: 1100 };
        const looks = existing.planet.tone !== planet.tone || existing.planet.icon !== planet.icon || existing.planet.radius !== planet.radius;
        existing.planet = planet;
        existing.leaving = false;
        if (looks) this.paint(existing);
        existing.g.setAttribute("aria-label", this.options.label(planet));
        continue;
      }
      const body = this.create(planet);
      if (first || this.options.reduced) placed.push(body);
      else {
        const lane = this.geometry.lanes[body.lane]!;
        body.x = planet.step === 0 ? stepX(lane, 0) - 30 * Math.sign(lane.dx) : stepX(lane, planet.step);
        body.y = lane.y;
      }
    }
    for (const [id, body] of this.bodies) {
      if (listed.has(id)) continue;
      if (this.options.reduced) {
        body.g.remove();
        this.bodies.delete(id);
      } else if (!body.leaving) {
        body.leaving = true;
        body.moving = { start: now + STAGGER * wave++, span: 0 };
      }
    }
    this.targets(0);
    for (const body of placed) [body.x, body.y, body.z, body.alpha] = [body.tx, body.ty, body.tz, 1];
    if (this.options.reduced) this.drawStill();
    else this.start();
  }

  private create(planet: Planet): Body {
    const lane = laneOf(planet);
    const g = element("g", { class: "zb-orb-planet", tabindex: 0, role: "link", "data-id": planet.id, "aria-label": this.options.label(planet) });
    const body: Body = { planet, lane, g, x: 0, y: this.geometry.lanes[lane]!.y, z: 0, alpha: 0, tx: 0, ty: 0, tz: 0, moving: null, leaving: false };
    this.paint(body);
    const state = this.lanes[lane]!;
    const show = (x: number, y: number): void => {
      state.frozen = body.planet.step;
      this.tipId = body.planet.id;
      g.classList.add("zb-orb-hot");
      this.options.onTip({ planet: body.planet, x, y });
      if (this.options.reduced) this.drawStill();
    };
    g.addEventListener("pointerdown", (event) => {
      this.lastPointer = event.pointerType;
    });
    g.addEventListener("pointerenter", (event) => {
      this.lastPointer = event.pointerType;
      show(event.clientX, event.clientY);
    });
    g.addEventListener("pointermove", (event) => this.options.onTipMove(event.clientX, event.clientY));
    g.addEventListener("pointerleave", () => {
      // Leaving a planet clears its freeze; the step stays open while the pointer is still over it.
      state.frozen = -1;
      g.classList.remove("zb-orb-hot");
      this.hideTip();
      if (this.options.reduced) this.drawStill();
    });
    g.addEventListener("focus", () => {
      const box = g.getBoundingClientRect();
      show(box.right, box.bottom);
    });
    g.addEventListener("blur", () => {
      state.frozen = -1;
      g.classList.remove("zb-orb-hot");
      this.hideTip();
      if (this.options.reduced) this.drawStill();
    });
    g.addEventListener("click", (event) => {
      // On a phone the first tap shows the transfer; a second tap on the same planet opens it.
      if (this.lastPointer === "touch" && this.tipId !== body.planet.id) {
        show(event.clientX, event.clientY);
        return;
      }
      this.options.onOpen(body.planet);
    });
    g.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.options.onOpen(body.planet);
      }
    });
    state.layer.append(g);
    this.bodies.set(planet.id, body);
    return body;
  }

  /**
   * A planet: its token's icon clipped to a circle inside a thin page-coloured outline. Until the icon loads (and if it
   * cannot), a disc in the token's tone with the symbol's first letter shows instead.
   */
  private paint(body: Body): void {
    const { radius, tone, icon, token } = body.planet;
    const letter = element("text", { class: "zb-orb-letter", "text-anchor": "middle", dy: "0.35em", "font-size": (radius * 0.95).toFixed(1) });
    letter.textContent = (token?.symbol.replace(/^zkb/i, "") ?? "M").slice(0, 1).toUpperCase();
    const parts: SVGElement[] = [element("circle", { r: (radius + 1.5).toFixed(2), class: "zb-orb-halo" }), element("circle", { r: radius.toFixed(2), class: `zb-orb-body zb-orb-t${tone}` }), letter];
    const pattern = icon === null ? null : this.patternFor(icon);
    if (pattern !== null) parts.push(element("circle", { r: radius.toFixed(2), class: "zb-orb-img", fill: `url(#${pattern.id})` }));
    body.g.setAttribute("data-icon", pattern === null ? "none" : pattern.state);
    body.g.replaceChildren(...parts);
  }

  /** One shared pattern per icon (never one per planet). Loading never blocks the animation: the planet shows its lettered disc until the image arrives. */
  private patternFor(url: string): { readonly id: string; state: "loading" | "ok" | "failed" } {
    const known = this.patterns.get(url);
    if (known !== undefined) return known;
    if (this.defs === null) {
      const svg = this.options.lanes[0].layer.ownerSVGElement;
      this.defs = element("defs", {});
      svg?.prepend(this.defs);
    }
    const entry: { readonly id: string; state: "loading" | "ok" | "failed" } = { id: `${this.uid}-${this.patterns.size}`, state: "loading" };
    const pattern = element("pattern", { id: entry.id, patternContentUnits: "objectBoundingBox", width: 1, height: 1 });
    const image = element("image", { href: url, width: 1, height: 1, preserveAspectRatio: "xMidYMid slice" });
    const settle = (state: "ok" | "failed"): void => {
      entry.state = state;
      for (const body of this.bodies.values()) if (body.planet.icon === url) body.g.setAttribute("data-icon", state);
    };
    image.addEventListener("load", () => settle("ok"));
    image.addEventListener("error", () => settle("failed"));
    pattern.append(image);
    this.defs.append(pattern);
    this.patterns.set(url, entry);
    return entry;
  }

  private hideTip(): void {
    this.tipId = null;
    this.options.onTip(null);
  }

  /** Where each planet should be: its slot on its step's orbits (or its destination chain). Advances the orbits' phases by `dt`. */
  private targets(dt: number): void {
    const byLane: Body[][][] = [[[], [], [], []], [[], [], [], []]];
    for (const body of this.bodies.values()) if (!body.leaving) byLane[body.lane]![body.planet.step]!.push(body);
    const still = this.options.reduced;
    this.lanes.forEach((state, index) => {
      const lane = this.geometry.lanes[index]!;
      const seenPaths = new Set<string>();
      for (let step = 0; step < 4; step++) {
        const group = byLane[index]![step]!;
        group.sort((a, b) => a.planet.sentAt - b.planet.sentAt || (a.planet.id < b.planet.id ? -1 : 1));
        const open = state.open[step]!;
        const cx = stepX(lane, step);
        let at = 0;
        for (let ring = 0; at < group.length; ring++) {
          const members = group.slice(at, at + PER * (ring + 1));
          const key = `${step}:${ring}`;
          const start = state.phase.get(key) ?? (step * 1.7 + ring * 2.3 + index) % (Math.PI * 2);
          const base = !still && state.frozen !== step ? start + (0.0045 / (ring + 1)) * (dt / 16.7) : start;
          state.phase.set(key, base);
          // Tilted at rest, near face-on when open.
          const radius = (R0 + ring * RING) * (0.72 + 0.28 * open);
          const squash = 0.66 + 0.24 * open;
          // The orbit's path, faint, behind the planets: it is what makes the tilt read as an orbit.
          let path = state.paths.get(key);
          if (path === undefined) {
            path = element("ellipse", { class: "zb-orb-path" });
            state.guides.append(path);
            state.paths.set(key, path);
          }
          path.setAttribute("cx", cx.toFixed(1));
          path.setAttribute("cy", String(lane.y));
          path.setAttribute("rx", radius.toFixed(1));
          path.setAttribute("ry", (radius * squash).toFixed(1));
          seenPaths.add(key);
          members.forEach((body, slot) => {
            const angle = base + (slot * Math.PI * 2) / members.length;
            const z = Math.sin(angle);
            body.tx = cx + Math.cos(angle) * radius;
            body.ty = lane.y + z * radius * squash;
            // Depth fades as the orbit opens toward face-on.
            body.tz = z * (1 - 0.6 * open);
          });
          at += members.length;
        }
      }
      for (const [key, path] of state.paths) {
        if (seenPaths.has(key)) continue;
        path.remove();
        state.paths.delete(key);
      }
    });
    for (const body of this.bodies.values()) {
      if (!body.leaving) continue;
      const exit = this.geometry.lanes[body.lane]!.exit;
      [body.tx, body.ty, body.tz] = [exit.x, exit.y, 0];
    }
  }

  private readonly frame = (time: number): void => {
    this.handle = null;
    if (this.destroyed) return;
    const dt = this.last === null ? 16 : Math.min(48, time - this.last);
    this.last = time;
    for (const state of this.lanes) for (let step = 0; step < 4; step++) state.open[step]! += ((state.hover === step || state.frozen === step ? 1 : 0) - state.open[step]!) * ease(dt, 160);
    this.targets(dt);
    for (const [id, body] of this.bodies) {
      if (body.moving !== null && time < body.moving.start) {
        // Waiting for its turn in the wave: it holds where it is.
        this.place(body, body.x, body.y);
        continue;
      }
      if (body.moving !== null && body.moving.span === 0) body.moving = null;
      const k = ease(dt, body.moving === null ? 120 : 260);
      body.x += (body.tx - body.x) * k;
      body.y += (body.ty - body.y) * k;
      let lift = 0;
      if (body.moving !== null) {
        // A step change arcs away from the loop's centre: up on the top lane, down on the bottom.
        const progress = Math.min(1, (time - body.moving.start) / body.moving.span);
        lift = this.geometry.lanes[body.lane]!.away * Math.sin(progress * Math.PI) * 26;
        if (progress >= 1) body.moving = null;
      }
      body.alpha += ((body.leaving ? 0 : 1) - body.alpha) * ease(dt, body.leaving ? 500 : 250);
      if (body.leaving && Math.hypot(body.x - body.tx, body.y - body.ty) < 3 && body.alpha < 0.05) {
        body.g.remove();
        this.bodies.delete(id);
        continue;
      }
      body.z += ((body.moving !== null || body.leaving ? 0 : body.tz) - body.z) * ease(dt, 120);
      this.place(body, body.x, body.y + lift);
    }
    this.restack();
    this.handle = this.frames.request(this.frame);
  };

  /** Draws every planet at its slot at once (reduced motion). */
  private drawStill(): void {
    for (const state of this.lanes) for (let step = 0; step < 4; step++) state.open[step] = state.hover === step || state.frozen === step ? 1 : 0;
    this.targets(0);
    for (const body of this.bodies.values()) {
      [body.x, body.y, body.z, body.alpha] = [body.tx, body.ty, body.tz, 1];
      this.place(body, body.x, body.y);
    }
    this.restack();
  }

  private place(body: Body, x: number, y: number): void {
    const scale = 1 + 0.38 * body.z; // nearer is bigger …
    body.g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${scale.toFixed(3)})`);
    body.g.setAttribute("opacity", (body.alpha * (0.62 + (0.38 * (body.z + 1)) / 2)).toFixed(2)); // … and brighter
  }

  /**
   * Back to front, per lane: planets behind their step first, then the suns (depth 0), then the planets in front, so a
   * planet passing behind its sun is hidden for a moment and the front ones overlap. Touches the DOM only when the order
   * changed, and never while a planet of the lane has focus (moving it would blur it).
   */
  private restack(): void {
    const active = this.doc.activeElement;
    this.lanes.forEach((state, index) => {
      if (active !== null && state.layer.contains(active)) return;
      const sorted = [...this.bodies.values()].filter((body) => body.lane === index).sort((a, b) => a.z - b.z);
      const behind = sorted.filter((body) => body.z < 0);
      const front = sorted.filter((body) => body.z >= 0);
      const order = `${behind.map((body) => body.planet.id).join()}|${front.map((body) => body.planet.id).join()}`;
      if (order === state.order) return;
      state.order = order;
      state.layer.append(...behind.map((body) => body.g), ...state.suns, ...front.map((body) => body.g));
    });
  }
}
