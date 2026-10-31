/**
 * The in-flight orbits' drawing (mockup design/ui/screens/inflight-orbits.html). One engine per track draws its planets
 * into an SVG group with one requestAnimationFrame loop, writing SVG attributes directly, so React never re-renders per
 * frame. At rest each step's planets crowd into a tilted orbit seen in depth (front bigger and brighter, drawn back to
 * front); hovering a step opens its orbit so the planets separate; hovering or focusing a planet freezes its orbit.
 * Every move is a glide: planets ease toward their slots, a step change arcs over the track, a departure drifts out
 * through the exit and fades. With reduced motion nothing animates: planets sit still on their rings and every change
 * is drawn once. The loop stops while the tab is hidden.
 */
import type { Planet } from "./orbit-model";

/** Where the track sits in the SVG's units (one unit is about one CSS pixel). */
export type OrbitGeometry = {
  readonly width: number;
  readonly height: number;
  /** The first and last step's x. */
  readonly x0: number;
  readonly x1: number;
  /** The track's y. */
  readonly y: number;
  /** The exit's x, right of the last step. */
  readonly exit: number;
};

/**
 * The geometry for a width in CSS pixels (clamped to 320–760), so planets keep their size on a phone.
 *
 * @param pixels The track's width.
 */
export const geometryFor = (pixels: number): OrbitGeometry => {
  // At 700 this is the mockup's track: X0 64, X1 636, exit X1 + 46, Y 125, H 250.
  const width = Math.round(Math.min(760, Math.max(320, pixels || 700)));
  const x0 = Math.round(Math.min(64, Math.max(46, width * (64 / 700))));
  const exit = width - 18;
  const x1 = Math.round(exit - Math.min(46, Math.max(30, width * (46 / 700))));
  return { width, height: 250, x0, x1, y: 125, exit };
};

/** The sun at each step and the exit marker. */
export const SUN_RADIUS = 15;
export const EXIT_RADIUS = 10;

/** A step's x. */
export const stepX = (geometry: OrbitGeometry, step: number): number => geometry.x0 + (step * (geometry.x1 - geometry.x0)) / 3;

/** The first orbit's radius, the gap to each further orbit, and the planets on the first orbit (each further one holds as many more). */
const R0 = 34;
const RING = 20;
const PER = 6;
/** How close (in units) the pointer must be to a step to open it. */
const HOVER_REACH = 70;

const SVG = "http://www.w3.org/2000/svg";

type Body = {
  planet: Planet;
  g: SVGGElement;
  body: SVGCircleElement;
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

/** What the engine tells the page. */
export type OrbitEngineOptions = {
  /** The group the planets and the step suns are drawn into, by depth (inside the track's SVG). */
  readonly layer: SVGGElement;
  /** The group of the faint orbit paths, behind the layer. */
  readonly guides: SVGGElement;
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

/** One track's planets. */
export class OrbitEngine {
  private readonly bodies = new Map<string, Body>();
  private readonly options: OrbitEngineOptions;
  private readonly frames: NonNullable<OrbitEngineOptions["frames"]>;
  private readonly doc: Document;
  private geometry: OrbitGeometry;
  private readonly open = [0, 0, 0, 0];
  private readonly phase = new Map<string, number>();
  private hover = -1;
  private frozen = -1;
  private tipId: string | null = null;
  private lastPointer = "mouse";
  private handle: number | null = null;
  private last: number | null = null;
  private order = "";
  private synced = false;
  private destroyed = false;
  private readonly cleanup: (() => void)[] = [];
  /** The step suns: in the planets' layer at depth 0, so a planet behind its step is hidden as it passes. */
  private readonly suns: SVGCircleElement[];
  /** The faint orbit paths by "step:ring". */
  private readonly paths = new Map<string, SVGEllipseElement>();

  constructor(options: OrbitEngineOptions) {
    this.options = options;
    this.geometry = options.geometry;
    this.doc = options.document ?? document;
    this.suns = [0, 1, 2, 3].map((step) => element("circle", { r: SUN_RADIUS, class: step === 0 ? "zb-orb-stop zb-orb-stop-first" : "zb-orb-stop", "data-sun": step }));
    this.placeSuns();
    options.layer.append(...this.suns);
    this.frames = options.frames ?? {
      request: (callback) => (typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(callback) : window.setTimeout(() => callback(performance.now()), 16)),
      cancel: (handle) => (typeof window.cancelAnimationFrame === "function" ? window.cancelAnimationFrame(handle) : window.clearTimeout(handle)),
    };
    const svg = options.layer.ownerSVGElement;
    if (svg !== null) {
      const move = (event: PointerEvent): void => {
        const box = svg.getBoundingClientRect();
        if (box.width === 0) return;
        const x = ((event.clientX - box.left) / box.width) * this.geometry.width;
        let best = -1;
        let distance = HOVER_REACH;
        for (let step = 0; step < 4; step++) {
          const d = Math.abs(x - stepX(this.geometry, step));
          if (d < distance) [distance, best] = [d, step];
        }
        this.setHover(best);
      };
      const leave = (): void => {
        this.frozen = -1;
        this.setHover(-1);
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
    for (const sun of this.suns) sun.remove();
    for (const path of this.paths.values()) path.remove();
    this.paths.clear();
  }

  private placeSuns(): void {
    this.suns.forEach((sun, step) => {
      sun.setAttribute("cx", String(stepX(this.geometry, step)));
      sun.setAttribute("cy", String(this.geometry.y));
    });
  }

  /** A new size. */
  setGeometry(geometry: OrbitGeometry): void {
    this.geometry = geometry;
    this.placeSuns();
    if (this.options.reduced) this.drawStill();
  }

  /** Opens one step's orbit (-1 closes them). */
  setHover(step: number): void {
    if (step === this.hover) return;
    this.hover = step;
    if (this.options.reduced) this.drawStill();
  }

  /**
   * The planets to draw now. New ones appear at their step (a new send enters from the left), ones whose step changed
   * travel to it, and ones no longer listed leave through the exit.
   */
  sync(planets: readonly Planet[]): void {
    const now = performance.now();
    const first = !this.synced;
    this.synced = true;
    const listed = new Set<string>();
    const placed: Body[] = [];
    for (const planet of planets) {
      listed.add(planet.id);
      const existing = this.bodies.get(planet.id);
      if (existing !== undefined) {
        if (existing.planet.step !== planet.step && !this.options.reduced) existing.moving = { start: now, span: 1100 };
        const looks = existing.planet.tone !== planet.tone || existing.planet.tier !== planet.tier || existing.planet.radius !== planet.radius;
        existing.planet = planet;
        existing.leaving = false;
        if (looks) this.paint(existing);
        existing.g.setAttribute("aria-label", this.options.label(planet));
        continue;
      }
      const body = this.create(planet);
      if (first || this.options.reduced) placed.push(body);
      else {
        body.x = planet.step === 0 ? stepX(this.geometry, 0) - 30 : stepX(this.geometry, planet.step);
        body.y = this.geometry.y;
      }
    }
    for (const [id, body] of this.bodies) {
      if (listed.has(id)) continue;
      if (this.options.reduced) {
        body.g.remove();
        this.bodies.delete(id);
      } else body.leaving = true;
    }
    this.targets(0);
    for (const body of placed) {
      body.x = body.tx;
      body.y = body.ty;
      body.z = body.tz;
      body.alpha = 1;
    }
    if (this.options.reduced) this.drawStill();
    else this.start();
  }

  private create(planet: Planet): Body {
    const g = element("g", { class: "zb-orb-planet", tabindex: 0, role: "link", "data-id": planet.id, "aria-label": this.options.label(planet) });
    const body: Body = { planet, g, body: element("circle", { r: 0 }), x: 0, y: this.geometry.y, z: 0, alpha: 0, tx: 0, ty: 0, tz: 0, moving: null, leaving: false };
    this.paint(body);
    const show = (x: number, y: number): void => {
      this.frozen = body.planet.step;
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
      g.classList.remove("zb-orb-hot");
      this.hideTip();
    });
    g.addEventListener("focus", () => {
      const box = g.getBoundingClientRect();
      show(box.right, box.bottom);
    });
    g.addEventListener("blur", () => {
      this.frozen = -1;
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
    this.options.layer.append(g);
    this.bodies.set(planet.id, body);
    return body;
  }

  /** A planet: a disc in its token's colour, an inner core for $1,000 or more, a ring for $10,000 or more. */
  private paint(body: Body): void {
    const { radius, tone, tier } = body.planet;
    const halo = element("circle", { r: (radius + 1.5).toFixed(2), class: "zb-orb-halo" });
    body.body = element("circle", { r: radius.toFixed(2), class: `zb-orb-body zb-orb-t${tone}` });
    const parts: SVGElement[] = [halo, body.body];
    if (tier !== "plain") parts.push(element("circle", { r: (radius * 0.38).toFixed(2), class: "zb-orb-core" }));
    if (tier === "ring") parts.push(element("ellipse", { rx: (radius + 5).toFixed(2), ry: ((radius + 5) * 0.35).toFixed(2), class: "zb-orb-ring", transform: "rotate(-18)" }));
    body.g.replaceChildren(...parts);
  }

  private hideTip(): void {
    this.tipId = null;
    this.options.onTip(null);
  }

  /** Where each planet should be: its slot on its step's orbits (or the exit). Advances the orbits' phases by `dt`. */
  private targets(dt: number): void {
    const byStep: Body[][] = [[], [], [], []];
    for (const body of this.bodies.values()) if (!body.leaving) byStep[body.planet.step]!.push(body);
    const still = this.options.reduced;
    const seenPaths = new Set<string>();
    for (let step = 0; step < 4; step++) {
      const group = byStep[step]!;
      group.sort((a, b) => a.planet.sentAt - b.planet.sentAt || (a.planet.id < b.planet.id ? -1 : 1));
      const open = this.open[step]!;
      let at = 0;
      for (let ring = 0; at < group.length; ring++) {
        const members = group.slice(at, at + PER * (ring + 1));
        const key = `${step}:${ring}`;
        const start = this.phase.get(key) ?? (step * 1.7 + ring * 2.3) % (Math.PI * 2);
        const turning = !still && this.frozen !== step;
        const base = turning ? start + (0.0045 / (ring + 1)) * (dt / 16.7) : start;
        this.phase.set(key, base);
        // Tilted at rest, near face-on when open.
        const radius = (R0 + ring * RING) * (0.72 + 0.28 * open);
        const squash = 0.66 + 0.24 * open;
        // The orbit's path, faint, behind the planets: it is what makes the tilt read as an orbit.
        let path = this.paths.get(key);
        if (path === undefined) {
          path = element("ellipse", { class: "zb-orb-path" });
          this.options.guides.append(path);
          this.paths.set(key, path);
        }
        path.setAttribute("cx", stepX(this.geometry, step).toFixed(1));
        path.setAttribute("cy", String(this.geometry.y));
        path.setAttribute("rx", radius.toFixed(1));
        path.setAttribute("ry", (radius * squash).toFixed(1));
        seenPaths.add(key);
        members.forEach((body, index) => {
          const angle = base + (index * Math.PI * 2) / members.length;
          const z = Math.sin(angle);
          body.tx = stepX(this.geometry, step) + Math.cos(angle) * radius;
          body.ty = this.geometry.y + z * radius * squash;
          // Depth fades as the orbit opens toward face-on.
          body.tz = z * (1 - 0.6 * open);
        });
        at += members.length;
      }
    }
    for (const body of this.bodies.values()) if (body.leaving) [body.tx, body.ty, body.tz] = [this.geometry.exit, this.geometry.y, 0];
    for (const [key, path] of this.paths) {
      if (seenPaths.has(key)) continue;
      path.remove();
      this.paths.delete(key);
    }
  }

  private readonly frame = (time: number): void => {
    this.handle = null;
    if (this.destroyed) return;
    const dt = this.last === null ? 16 : Math.min(48, time - this.last);
    this.last = time;
    for (let step = 0; step < 4; step++) this.open[step]! += ((this.hover === step || this.frozen === step ? 1 : 0) - this.open[step]!) * ease(dt, 160);
    this.targets(dt);
    for (const [id, body] of this.bodies) {
      const k = ease(dt, body.moving === null ? 120 : 260);
      body.x += (body.tx - body.x) * k;
      body.y += (body.ty - body.y) * k;
      let lift = 0;
      if (body.moving !== null) {
        // A step change arcs up and over the track.
        const progress = Math.min(1, (time - body.moving.start) / body.moving.span);
        lift = -Math.sin(progress * Math.PI) * 26;
        if (progress >= 1) body.moving = null;
      }
      body.alpha += ((body.leaving ? 0 : 1) - body.alpha) * ease(dt, body.leaving ? 500 : 250);
      if (body.leaving && Math.abs(body.x - this.geometry.exit) < 2 && body.alpha < 0.05) {
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
    for (let step = 0; step < 4; step++) this.open[step] = this.hover === step || this.frozen === step ? 1 : 0;
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
   * Back to front: planets behind their step first, then the suns (depth 0), then the planets in front, so a planet
   * passing behind its sun is hidden for a moment and the front ones overlap. Touches the DOM only when the order changed.
   */
  private restack(): void {
    // Moving a focused planet would blur it; keep the order while one has focus.
    const active = this.doc.activeElement;
    if (active !== null && this.options.layer.contains(active)) return;
    const sorted = [...this.bodies.values()].sort((a, b) => a.z - b.z);
    const behind = sorted.filter((body) => body.z < 0);
    const front = sorted.filter((body) => body.z >= 0);
    const order = `${behind.map((body) => body.planet.id).join()}|${front.map((body) => body.planet.id).join()}`;
    if (order === this.order) return;
    this.order = order;
    this.options.layer.append(...behind.map((body) => body.g), ...this.suns, ...front.map((body) => body.g));
  }
}

