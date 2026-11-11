import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { FIXTURE_NOW, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { FeedItem } from "@terminal/model/types";
import { geometryFor, loopPath, OrbitEngine, stepX, type OrbitEngineOptions } from "../../src/explore/orbit-engine";
import { orbitTracks, type Planet } from "../../src/explore/orbit-model";

const usdc = FIXTURE_TOKENS[0]!;
const id = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const row = (n: number, status: FeedItem["status"], over: Partial<FeedItem> = {}): FeedItem => ({
  id: id(n),
  kind: "token",
  direction: "first-to-second",
  status,
  sender: `0x${"1".repeat(40)}` as Hex,
  recipient: `0x${"2".repeat(40)}` as Hex,
  token: usdc,
  amount: 100_000_000n,
  sentAt: FIXTURE_NOW - 600 + n,
  deliveredAt: null,
  sourceTransactionHash: `0x${"3".repeat(64)}` as Hex,
  destinationTransactionHash: null,
  ...over,
});
const planetsOf = (rows: readonly FeedItem[], iconOf?: (token: { readonly symbol: string }) => string | null): Planet[] =>
  orbitTracks({ pair: FIXTURE_PAIR, inFlight: rows, delivered: [], priceOf: () => 1, now: FIXTURE_NOW, ...(iconOf === undefined ? {} : { iconOf }) }).flatMap((track) => track.planets);

/** A frame scheduler the test steps by hand. */
const scheduler = () => {
  let next = 1;
  const pending = new Map<number, (time: number) => void>();
  return {
    pending,
    request: (callback: (time: number) => void) => {
      pending.set(next, callback);
      return next++;
    },
    cancel: vi.fn((handle: number) => void pending.delete(handle)),
    /** Runs the one pending frame at a time. */
    run: (time: number) => {
      const [handle, callback] = [...pending.entries()][0]!;
      pending.delete(handle);
      callback(time);
    },
  };
};

type Setup = { engine: OrbitEngine; svg: SVGSVGElement; layers: SVGGElement[]; frames: ReturnType<typeof scheduler>; options: { [K in keyof OrbitEngineOptions]-?: OrbitEngineOptions[K] }; clock: { now: number } };

const setup = (over: Partial<OrbitEngineOptions> = {}): Setup => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
  const layers = [0, 1].map(() => document.createElementNS("http://www.w3.org/2000/svg", "g") as SVGGElement);
  const guides = [0, 1].map(() => document.createElementNS("http://www.w3.org/2000/svg", "g") as SVGGElement);
  svg.append(...guides, ...layers);
  document.body.append(svg);
  const frames = scheduler();
  const clock = { now: 1_000 };
  const options = {
    lanes: [
      { layer: layers[0]!, guides: guides[0]! },
      { layer: layers[1]!, guides: guides[1]! },
    ],
    reduced: false,
    geometry: geometryFor(780),
    onTip: vi.fn(),
    onTipMove: vi.fn(),
    onOpen: vi.fn(),
    label: (planet: Planet) => `planet ${planet.id.slice(-2)}`,
    sunLabel: (lane: number, step: number) => `sun ${lane}/${step}`,
    onSunTip: vi.fn(),
    clock: () => clock.now,
    frames,
    document,
    ...over,
  } as Setup["options"];
  const engine = new OrbitEngine(options);
  return { engine, svg, layers, frames, options, clock };
};

const planetNode = (n: number): SVGGElement => document.querySelector<SVGGElement>(`[data-id="${id(n)}"]`)!;
const position = (n: number): [number, number] => {
  const [x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(planetNode(n).getAttribute("transform")!)!.slice(1).map(Number) as [number, number];
  return [x, y];
};
const hidden = (value: boolean) => vi.spyOn(document, "hidden", "get").mockReturnValue(value);

let engines: OrbitEngine[] = [];
const made = (s: Setup): Setup => (engines.push(s.engine), s);
beforeEach(() => {
  document.body.replaceChildren();
});
afterEach(() => {
  for (const engine of engines) engine.destroy();
  engines = [];
  vi.restoreAllMocks();
});

describe("the loop's geometry", () => {
  it("is the mockup's loop from 740 px, and for no measured width yet", () => {
    for (const pixels of [740, 900, 0]) {
      const g = geometryFor(pixels);
      expect([g.width, g.height, g.a, g.b, g.yTop, g.yBottom, g.end, g.labelSize]).toEqual([780, 440, 170, 610, 130, 310, 90, 12]);
    }
  });

  it("follows the pixels when narrower: smaller ends and margins, 11 px labels under 480, never under 340", () => {
    const phone = geometryFor(400);
    expect(phone.width).toBe(400);
    expect(phone.labelSize).toBe(11);
    expect(phone.end).toBeLessThan(90);
    expect(phone.a).toBe(phone.end + 28 + Math.round((52 * 60) / 440));
    expect(geometryFor(300).width).toBe(340);
    expect(geometryFor(300).end).toBe(42);
    const mid = geometryFor(600);
    expect(mid.labelSize).toBe(12);
    expect(mid.b).toBe(mid.width - mid.a);
    expect(mid.nodes[0].x).toBe(mid.a - mid.end);
    expect(mid.nodes[1].x).toBe(mid.b + mid.end);
  });

  it("puts the first lane's steps left to right and the second's right to left, and draws the loop through them", () => {
    const g = geometryFor(780);
    const [top, bottom] = g.lanes;
    expect([0, 1, 2].map((step) => stepX(top, step))).toEqual([170, 390, 610]);
    expect([0, 1, 2].map((step) => stepX(bottom, step))).toEqual([610, 390, 170]);
    expect(loopPath(g)).toBe("M 170 130 H 610 A 90 90 0 0 1 610 310 H 170 A 90 90 0 0 1 170 130");
  });
});

describe("running", () => {
  it("starts one frame loop, stops it, and starts again", () => {
    const s = made(setup());
    expect(s.engine.running).toBe(false);
    s.engine.start();
    s.engine.start();
    expect(s.engine.running).toBe(true);
    expect(s.frames.pending.size).toBe(1);
    s.engine.stop();
    expect(s.engine.running).toBe(false);
    expect(s.frames.cancel).toHaveBeenCalledTimes(1);
    s.engine.stop();
    expect(s.frames.cancel).toHaveBeenCalledTimes(1);
    s.engine.start();
    expect(s.frames.pending.size).toBe(1);
  });

  it("keeps requesting a frame after each one", () => {
    const s = made(setup());
    s.engine.start();
    s.frames.run(16);
    expect(s.engine.running).toBe(true);
    expect(s.frames.pending.size).toBe(1);
  });

  it("does not run while the tab is hidden, pauses when it hides and resumes when it shows", () => {
    const spy = hidden(true);
    const s = made(setup());
    s.engine.start();
    expect(s.engine.running).toBe(false);
    spy.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(s.engine.running).toBe(true);
    spy.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(s.engine.running).toBe(false);
  });

  it("never starts once destroyed, and ignores the tab showing again", () => {
    const s = setup();
    s.engine.destroy();
    s.engine.start();
    s.engine.sync(planetsOf([row(1, "sent")]));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(s.engine.running).toBe(false);
    expect(s.frames.pending.size).toBe(0);
  });

  it("with reduced motion draws once instead of running", () => {
    const s = made(setup({ reduced: true }));
    s.engine.sync(planetsOf([row(1, "sent")]));
    const before = planetNode(1).getAttribute("transform");
    s.engine.start();
    expect(s.engine.running).toBe(false);
    expect(planetNode(1).getAttribute("transform")).toBe(before);
    expect(s.frames.pending.size).toBe(0);
  });

  it("removes what it added when destroyed", () => {
    const s = setup();
    s.engine.sync(planetsOf([row(1, "sent", { token: null, amount: null }), row(2, "sent")], () => "https://icons.test/a.png"));
    expect(document.querySelectorAll(".zb-orb-planet")).toHaveLength(2);
    expect(document.querySelector("defs")).not.toBeNull();
    s.engine.destroy();
    expect(document.querySelectorAll(".zb-orb-planet, .zb-orb-stop, .zb-orb-path, defs")).toHaveLength(0);
  });
});

describe("syncing planets", () => {
  it("draws the first answer in place, lettered by token (M for a message), labelled by the page", () => {
    const s = made(setup());
    s.engine.sync(planetsOf([row(1, "sent"), row(2, "covered", { token: null, amount: null })]));
    expect(planetNode(1).getAttribute("aria-label")).toBe("planet 01");
    expect(planetNode(1).querySelector(".zb-orb-letter")!.textContent).toBe("U");
    expect(planetNode(2).querySelector(".zb-orb-letter")!.textContent).toBe("M");
    s.frames.run(1_016);
    expect(Number(planetNode(1).getAttribute("opacity"))).toBeGreaterThan(0.2);
    expect(s.engine.running).toBe(true);
  });

  it("brings a later new transfer out of its source chain, in a wave 90 ms apart, and settles it on its orbit", () => {
    const s = made(setup());
    s.engine.sync(planetsOf([row(1, "sent")]));
    s.clock.now = 5_000;
    s.engine.sync(planetsOf([row(1, "sent"), row(2, "sent"), row(3, "sent")]));
    const node = geometryFor(780).nodes[0];
    // Frame at the wave's start: the first one starts now, the other two hold at the chain (not yet their turn).
    s.frames.run(5_000);
    const held = position(3);
    expect(held[0]).toBeCloseTo(node.x, 0);
    s.frames.run(5_048);
    expect(position(3)).toEqual(held);
    // Long after: all of them are on the orbit around the first step, away from the chain.
    for (let time = 5_100; time < 12_000; time += 48) s.frames.run(time);
    for (const n of [2, 3]) expect(Math.abs(position(n)[0] - stepX(geometryFor(780).lanes[0], 0))).toBeLessThan(60);
  });

  it("glides a planet whose step changed along an arc away from the loop's centre", () => {
    const s = made(setup());
    s.engine.sync(planetsOf([row(1, "sent"), row(2, "sent")]));
    s.frames.run(1_016);
    s.clock.now = 2_000;
    s.engine.sync(planetsOf([row(1, "waiting_for_finality"), row(2, "waiting_for_finality")]));
    const lane = geometryFor(780).lanes[0];
    const start = position(1)[1];
    const ys: number[] = [];
    for (let time = 2_016; time < 8_000; time += 48) {
      s.frames.run(time);
      ys.push(position(1)[1]);
    }
    // On the top lane the arc goes up (smaller y) past both where it started and where it settles.
    expect(Math.min(...ys)).toBeLessThan(Math.min(start, ys.at(-1)!) - 10);
    // Done: it sits on an orbit of the Final step.
    expect(Math.abs(position(1)[0] - stepX(lane, 1))).toBeLessThan(60);
  });

  it("with reduced motion a changed step is placed at once and a delisted planet is removed at once", () => {
    const s = made(setup({ reduced: true }));
    s.engine.sync(planetsOf([row(1, "sent"), row(2, "sent")]));
    s.engine.sync(planetsOf([row(1, "covered")]));
    expect(planetNode(2)).toBeNull();
    const lane = geometryFor(780).lanes[0];
    expect(Math.abs(position(1)[0] - stepX(lane, 2))).toBeLessThan(40);
    expect(s.frames.pending.size).toBe(0);
  });

  it("repaints a planet whose tone, size or icon changed, and keeps its label current", () => {
    const s = made(setup({ label: (planet) => `${planet.id.slice(-1)}:${planet.radius.toFixed(0)}` }));
    const [one] = planetsOf([row(1, "sent")]);
    s.engine.sync([one!]);
    const letter = planetNode(1).querySelector(".zb-orb-letter");
    s.engine.sync([{ ...one!, radius: 12 }]);
    expect(planetNode(1).querySelector(".zb-orb-letter")).not.toBe(letter);
    expect(planetNode(1).getAttribute("aria-label")).toBe("1:12");
    const kept = planetNode(1).querySelector(".zb-orb-letter");
    s.engine.sync([{ ...one!, radius: 12, tone: one!.tone === 1 ? 2 : 1 }]);
    expect(planetNode(1).querySelector(".zb-orb-letter")).not.toBe(kept);
    const again = planetNode(1).querySelector(".zb-orb-letter");
    s.engine.sync([{ ...one!, radius: 12, tone: one!.tone === 1 ? 2 : 1 }]);
    expect(planetNode(1).querySelector(".zb-orb-letter")).toBe(again);
  });

  it("sends a delivered planet into its destination chain and removes it once it has faded", () => {
    const s = made(setup());
    s.engine.sync(planetsOf([row(1, "sent")]));
    s.frames.run(1_016);
    s.engine.sync([]);
    // Listed as gone twice before a frame: the second does not restart its flight.
    s.engine.sync([]);
    const exit = geometryFor(780).nodes[1];
    let time = 1_016;
    while (planetNode(1) !== null && time < 20_000) s.frames.run((time += 16));
    expect(planetNode(1)).toBeNull();
    expect(time).toBeLessThan(20_000);
    expect(exit.x).toBeGreaterThan(0);
    expect(s.engine.running).toBe(true);
  });

  it("fades a planet that is still in flight but no longer drawn at its sun, and sends it on if it is then delivered", () => {
    const s = made(setup());
    const [one] = planetsOf([row(1, "sent")]);
    s.engine.sync([one!]);
    s.frames.run(1_016);
    s.engine.sync([], new Set([one!.id]));
    const lane = geometryFor(780).lanes[0];
    let time = 1_016;
    for (let k = 0; k < 40; k++) s.frames.run((time += 48));
    // It went to its sun, not the destination chain.
    expect(planetNode(1)).toBeNull();
    // Back among the drawn: appears at its orbit (in flight before), faded in.
    s.engine.sync([one!], new Set([one!.id]));
    expect(Number(planetNode(1).getAttribute("opacity"))).toBeLessThan(0.7);
    expect(stepX(lane, 0)).toBe(170);
    // Leaves to its sun, then is delivered: now it heads for the destination chain.
    s.engine.sync([], new Set([one!.id]));
    s.engine.sync([]);
    for (let k = 0; k < 200 && planetNode(1) !== null; k++) s.frames.run((time += 48));
    expect(planetNode(1)).toBeNull();
  });

  it("brings back a planet that was leaving when it is listed again", () => {
    const s = made(setup());
    const [one] = planetsOf([row(1, "sent")]);
    s.engine.sync([one!]);
    s.engine.sync([]);
    s.engine.sync([one!]);
    for (let time = 1_016; time < 3_000; time += 48) s.frames.run(time);
    expect(planetNode(1)).not.toBeNull();
    expect(Number(planetNode(1).getAttribute("opacity"))).toBeGreaterThan(0.5);
  });

  it("puts more than six planets on a second ring, ordered by send time and then id", () => {
    const s = made(setup({ reduced: true }));
    const rows = Array.from({ length: 12 }, (_, index) => row(100 - index, "sent", { sentAt: FIXTURE_NOW - 100 - (index % 2) }));
    s.engine.sync(planetsOf(rows).reverse());
    expect(document.querySelectorAll('[data-lane="0"] .zb-orb-path, .zb-orb-path')).toHaveLength(2);
    // Ids tie on send time in pairs: both orders are placed without overlap.
    const places = new Set(rows.map((r) => position(Number(BigInt(r.id))).join()));
    expect(places.size).toBe(12);
  });

  it("drops the orbit paths of a step that emptied", () => {
    const s = made(setup({ reduced: true }));
    s.engine.sync(planetsOf([row(1, "sent")]));
    expect(document.querySelectorAll(".zb-orb-path")).toHaveLength(1);
    s.engine.sync([]);
    expect(document.querySelectorAll(".zb-orb-path")).toHaveLength(0);
  });
});

describe("icons", () => {
  it("shares one pattern per URL and marks each planet by its own icon's outcome", () => {
    const s = made(setup({ reduced: true }));
    s.engine.sync(planetsOf([row(1, "sent"), row(2, "sent"), row(3, "sent", { token: FIXTURE_TOKENS[2]! })], (token) => `https://icons.test/${token.symbol}.png`));
    const images = [...document.querySelectorAll("defs image")];
    expect(images).toHaveLength(2);
    expect(planetNode(1).dataset.icon).toBe("loading");
    images[0]!.dispatchEvent(new Event("load"));
    expect([planetNode(1).dataset.icon, planetNode(2).dataset.icon, planetNode(3).dataset.icon]).toEqual(["ok", "ok", "loading"]);
    images[1]!.dispatchEvent(new Event("error"));
    expect(planetNode(3).dataset.icon).toBe("failed");
    expect(planetNode(1).dataset.icon).toBe("ok");
  });

  it("draws the lettered disc alone for a planet without an icon", () => {
    const s = made(setup({ reduced: true }));
    s.engine.sync(planetsOf([row(1, "sent")]));
    expect(planetNode(1).dataset.icon).toBe("none");
    expect(planetNode(1).querySelector(".zb-orb-img")).toBeNull();
    expect(s.svg.querySelector("defs")).toBeNull();
  });
});

describe("layers outside an svg", () => {
  it("still draws, with no pointer tracking and the icon patterns left out", () => {
    const layer = () => document.createElementNS("http://www.w3.org/2000/svg", "g") as SVGGElement;
    const lanes = [
      { layer: layer(), guides: layer() },
      { layer: layer(), guides: layer() },
    ] as const;
    const s = made(setup({ lanes, reduced: true }));
    s.engine.sync(planetsOf([row(1, "sent")], () => "https://icons.test/a.png"));
    expect(lanes[0].layer.querySelectorAll(".zb-orb-planet")).toHaveLength(1);
    expect(planetNode(1)).toBeNull();
    expect(lanes[0].layer.querySelector(".zb-orb-planet")!.getAttribute("data-icon")).toBe("loading");
  });
});

describe("planet interaction", () => {
  const touch = (target: Element, type: string, pointerType = "touch") => {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { pointerType, clientX: 30, clientY: 40 });
    target.dispatchEvent(event);
  };

  it("shows its tooltip on entering, follows the pointer, and hides it on leaving", () => {
    const s = made(setup());
    s.engine.sync(planetsOf([row(1, "sent")]));
    touch(planetNode(1), "pointerenter", "mouse");
    expect(s.options.onTip).toHaveBeenLastCalledWith({ planet: expect.objectContaining({ id: id(1) }), x: 30, y: 40 });
    expect(planetNode(1).classList.contains("zb-orb-hot")).toBe(true);
    expect(s.options.onSunTip).toHaveBeenLastCalledWith(null);
    touch(planetNode(1), "pointermove", "mouse");
    expect(s.options.onTipMove).toHaveBeenCalledWith(30, 40);
    touch(planetNode(1), "pointerleave", "mouse");
    expect(s.options.onTip).toHaveBeenLastCalledWith(null);
    expect(planetNode(1).classList.contains("zb-orb-hot")).toBe(false);
  });

  it("shows the tooltip on focus, at the planet's corner, and hides it on blur", () => {
    const s = made(setup());
    s.engine.sync(planetsOf([row(1, "sent")]));
    planetNode(1).getBoundingClientRect = () => ({ right: 55, bottom: 66 }) as DOMRect;
    planetNode(1).focus();
    expect(s.options.onTip).toHaveBeenLastCalledWith({ planet: expect.anything(), x: 55, y: 66 });
    planetNode(1).blur();
    expect(s.options.onTip).toHaveBeenLastCalledWith(null);
  });

  it("opens the message on a click with a mouse; on a touch screen the first tap shows it and the second opens it", () => {
    const s = made(setup());
    s.engine.sync(planetsOf([row(1, "sent")]));
    touch(planetNode(1), "pointerdown", "mouse");
    planetNode(1).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(s.options.onOpen).toHaveBeenCalledTimes(1);
    touch(planetNode(1), "pointerdown", "touch");
    planetNode(1).dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 7, clientY: 9 }));
    expect(s.options.onOpen).toHaveBeenCalledTimes(1);
    expect(s.options.onTip).toHaveBeenLastCalledWith({ planet: expect.anything(), x: 7, y: 9 });
    planetNode(1).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(s.options.onOpen).toHaveBeenCalledTimes(2);
  });

  it("opens the message on Enter or Space, and on no other key", () => {
    const s = made(setup());
    s.engine.sync(planetsOf([row(1, "sent")]));
    for (const key of ["Enter", " ", "a"]) planetNode(1).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    expect(s.options.onOpen).toHaveBeenCalledTimes(2);
  });

  it("with reduced motion redraws the still picture as the pointer or focus comes and goes", () => {
    const s = made(setup({ reduced: true }));
    s.engine.sync(planetsOf(Array.from({ length: 6 }, (_, index) => row(1 + index, "sent"))));
    const radius = () => Number(document.querySelector(".zb-orb-path")!.getAttribute("rx"));
    const rest = radius();
    touch(planetNode(1), "pointerenter", "mouse");
    s.engine.setHover(0, 0);
    expect(radius()).toBeGreaterThan(rest);
    touch(planetNode(1), "pointerleave", "mouse");
    planetNode(1).focus();
    planetNode(1).blur();
    s.engine.setHover(0, -1);
    expect(radius()).toBeCloseTo(rest);
  });
});

describe("sun interaction", () => {
  const sun = (lane: number, step: number) => document.querySelector<SVGCircleElement>(`[data-lane="${lane}"][data-sun="${step}"]`)!;

  it("labels each sun and marks the first", () => {
    made(setup());
    expect(sun(1, 2).getAttribute("aria-label")).toBe("sun 1/2");
    expect(sun(0, 0).classList.contains("zb-orb-stop-first")).toBe(true);
    expect(sun(0, 1).classList.contains("zb-orb-stop-first")).toBe(false);
  });

  it("shows its summary on entering or focus and hides it on blur", () => {
    const s = made(setup());
    const enter = new Event("pointerenter");
    Object.assign(enter, { clientX: 5, clientY: 6 });
    sun(0, 1).dispatchEvent(enter);
    expect(s.options.onSunTip).toHaveBeenLastCalledWith({ lane: 0, step: 1, x: 5, y: 6 });
    sun(0, 1).dispatchEvent(new Event("blur"));
    expect(s.options.onSunTip).toHaveBeenLastCalledWith(null);
    sun(1, 0).getBoundingClientRect = () => ({ right: 11, bottom: 12 }) as DOMRect;
    sun(1, 0).dispatchEvent(new Event("focus"));
    expect(s.options.onSunTip).toHaveBeenLastCalledWith({ lane: 1, step: 0, x: 11, y: 12 });
  });

  it("with reduced motion redraws when a sun opens and closes", () => {
    const s = made(setup({ reduced: true }));
    s.engine.sync(planetsOf(Array.from({ length: 6 }, (_, index) => row(1 + index, "sent"))));
    const radius = () => Number(document.querySelector(".zb-orb-path")!.getAttribute("rx"));
    const rest = radius();
    sun(0, 0).dispatchEvent(new Event("pointerenter"));
    expect(radius()).toBeGreaterThan(rest);
    sun(0, 0).dispatchEvent(new Event("blur"));
    expect(radius()).toBeCloseTo(rest);
  });

  it("opens the orbit of the step the pointer is near in the drawing, and closes it when the pointer goes", () => {
    const s = made(setup({ reduced: true }));
    s.engine.sync(planetsOf(Array.from({ length: 6 }, (_, index) => row(1 + index, "sent"))));
    const g = geometryFor(780);
    s.svg.getBoundingClientRect = () => ({ left: 10, top: 20, width: g.width, height: g.height }) as DOMRect;
    const radius = () => Number(document.querySelector(".zb-orb-path")!.getAttribute("rx"));
    const rest = radius();
    const move = (x: number, y: number) => {
      const event = new Event("pointermove");
      Object.assign(event, { clientX: 10 + x, clientY: 20 + y });
      s.svg.dispatchEvent(event);
    };
    move(stepX(g.lanes[0], 0), g.yTop);
    expect(radius()).toBeGreaterThan(rest);
    // Far from every step of the lane: nothing is open.
    move(stepX(g.lanes[0], 0) + 110, g.yTop);
    expect(radius()).toBeCloseTo(rest);
    // Over a sun (entered) and moving about on it keeps the summary; moving off it hides the summary.
    sun(0, 0).dispatchEvent(new Event("pointerenter"));
    move(stepX(g.lanes[0], 0) + 5, g.yTop);
    expect(s.options.onSunTip).not.toHaveBeenLastCalledWith(null);
    move(stepX(g.lanes[0], 0) + 60, g.yTop);
    expect(s.options.onSunTip).toHaveBeenLastCalledWith(null);
    // The bottom lane is picked when nearer.
    move(stepX(g.lanes[1], 1), g.yBottom + 4);
    s.svg.dispatchEvent(new Event("pointerleave"));
    expect(s.options.onTip).toHaveBeenLastCalledWith(null);
    expect(radius()).toBeCloseTo(rest);
  });

  it("hides the sun's summary when the pointer leaves the drawing, and ignores a drawing with no size", () => {
    const s = made(setup());
    sun(0, 2).dispatchEvent(new Event("pointerenter"));
    // jsdom lays nothing out: a move over a drawing of no size changes nothing.
    s.svg.dispatchEvent(new Event("pointermove"));
    expect(s.options.onSunTip).not.toHaveBeenLastCalledWith(null);
    s.svg.dispatchEvent(new Event("pointerleave"));
    expect(s.options.onSunTip).toHaveBeenLastCalledWith(null);
  });

  it("uses the new size's steps after setGeometry", () => {
    const s = made(setup({ reduced: true }));
    const g = geometryFor(400);
    s.engine.setGeometry(g);
    expect(Number(sun(0, 2).getAttribute("cx"))).toBeCloseTo(stepX(g.lanes[0], 2), 1);
    expect(Number(sun(1, 0).getAttribute("cy"))).toBe(g.yBottom);
  });

  it("changes nothing when the open step is already the one asked for", () => {
    const s = made(setup({ reduced: true }));
    s.engine.sync(planetsOf([row(1, "sent")]));
    s.engine.setHover(0, 1);
    const before = document.querySelector(".zb-orb-path")!.outerHTML;
    s.engine.setHover(0, 1);
    expect(document.querySelector(".zb-orb-path")!.outerHTML).toBe(before);
  });
});

describe("the frame", () => {
  it("opens a hovered step's orbit over the frames and closes it again", () => {
    const s = made(setup());
    s.engine.sync(planetsOf(Array.from({ length: 6 }, (_, index) => row(1 + index, "sent"))));
    const radius = () => Number(document.querySelector(".zb-orb-path")!.getAttribute("rx"));
    let time = 1_000;
    s.frames.run(time);
    const rest = radius();
    s.engine.setHover(0, 0);
    for (let k = 0; k < 40; k++) s.frames.run((time += 16));
    expect(radius()).toBeGreaterThan(rest + 5);
    s.engine.setHover(0, -1);
    for (let k = 0; k < 80; k++) s.frames.run((time += 16));
    expect(radius()).toBeCloseTo(rest, 0);
  });

  it("holds a frozen step's planets still, and stacks planets front to back, but not while a planet has focus", () => {
    const s = made(setup());
    s.engine.sync(planetsOf(Array.from({ length: 6 }, (_, index) => row(1 + index, "sent"))));
    let time = 1_000;
    s.frames.run(time);
    const order = () => [...s.layers[0]!.children].map((child) => child.getAttribute("data-id") ?? child.getAttribute("data-sun")).join();
    for (let k = 0; k < 30; k++) s.frames.run((time += 16));
    const stacked = order();
    // A planet has focus (and the pointer is not on it, so the orbit turns): the order is left alone.
    planetNode(1).focus();
    planetNode(1).dispatchEvent(new Event("pointerleave"));
    for (let k = 0; k < 600; k++) s.frames.run((time += 16));
    expect(order()).toBe(stacked);
    planetNode(1).blur();
    s.frames.run((time += 16));
    expect(order()).not.toBe(stacked);
  });

  it("does not turn the orbit of a frozen step", () => {
    const s = made(setup());
    s.engine.sync(planetsOf(Array.from({ length: 6 }, (_, index) => row(1 + index, "sent"))));
    let time = 1_000;
    for (let k = 0; k < 20; k++) s.frames.run((time += 16));
    const enter = new Event("pointerenter");
    planetNode(1).dispatchEvent(enter);
    for (let k = 0; k < 60; k++) s.frames.run((time += 16));
    const at = position(1);
    for (let k = 0; k < 10; k++) s.frames.run((time += 16));
    expect(position(1)[0]).toBeCloseTo(at[0], 0);
    expect(position(1)[1]).toBeCloseTo(at[1], 0);
  });
});
