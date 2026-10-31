import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { FIXTURE_NOW, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { FeedItem } from "@terminal/model/types";
import { InFlightOrbits } from "../../src/explore/InFlightOrbits";
import { dayStartOf, orbitTracks, type OrbitTrack } from "../../src/explore/orbit-model";

const usdc = FIXTURE_TOKENS[0]!;
const id = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const row = (n: number, status: FeedItem["status"], direction: FeedItem["direction"] = "first-to-second"): FeedItem => ({
  id: id(n),
  kind: "token",
  direction,
  status,
  sender: `0x${"1".repeat(40)}` as Hex,
  recipient: `0xabcdef${"2".repeat(30)}1234` as Hex,
  token: usdc,
  amount: 1_500_000_000n,
  sentAt: FIXTURE_NOW - 180,
  deliveredAt: null,
  sourceTransactionHash: `0x${"3".repeat(64)}` as Hex,
  destinationTransactionHash: null,
});

const tracksOf = (inFlight: readonly FeedItem[]): readonly OrbitTrack[] =>
  orbitTracks({ pair: FIXTURE_PAIR, inFlight, delivered: [], priceOf: () => 1, now: FIXTURE_NOW, dayStart: dayStartOf(FIXTURE_NOW) });

let frames: ReturnType<typeof vi.fn>;
beforeEach(() => {
  window.location.hash = "#/explore";
  frames = vi.fn(() => 1);
  vi.stubGlobal("requestAnimationFrame", frames);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("in-flight orbits", () => {
  it("draws one loop for the pair, each chain once, with no header lines above it", () => {
    const { container } = render(<InFlightOrbits tracks={tracksOf([row(1, "sent"), row(2, "covered"), row(3, "sent", "second-to-first")])} now={FIXTURE_NOW} reducedMotion />);
    const [first, second] = [FIXTURE_PAIR.first.name.split(" ")[0], FIXTURE_PAIR.second.name.split(" ")[0]];
    expect(container.querySelector(".zb-orb-head")).toBeNull();
    expect(container.querySelectorAll("svg.zb-orb-svg")).toHaveLength(1);
    expect(screen.getByRole("group", { name: `Transfers in flight between ${first} and ${second}: 3` })).toBeInTheDocument();
    expect(container.querySelectorAll(".zb-orb-track")).toHaveLength(1);
    expect(document.querySelectorAll(".zb-orb-planet")).toHaveLength(3);
    // The end nodes: the first chain on the left, the second on the right, each once, with its icon on a plate.
    const nodes = [...container.querySelectorAll<SVGCircleElement>(".zb-orb-node")];
    expect(nodes.map((node) => Number(node.dataset.chain))).toEqual([FIXTURE_PAIR.first.chainId, FIXTURE_PAIR.second.chainId]);
    expect(Number(nodes[0]!.getAttribute("cx"))).toBeLessThan(Number(nodes[1]!.getAttribute("cx")));
    expect(container.querySelectorAll(".zb-orb-chain .zb-tok-icon.zb-on-accent")).toHaveLength(2);
    expect([...container.querySelectorAll(".zb-orb-node-name")].map((node) => node.textContent)).toEqual([first, second]);
  });

  it("shows a chain's totals on hover or focus of its node: leaving in flight per step, delivered here today, value", async () => {
    const delivered: FeedItem = { ...row(40, "delivered", "first-to-second"), deliveredAt: FIXTURE_NOW - 30 };
    const tracks = orbitTracks({ pair: FIXTURE_PAIR, inFlight: [row(1, "sent"), row(2, "covered"), row(3, "sent", "second-to-first")], delivered: [delivered], priceOf: () => 1, now: FIXTURE_NOW, dayStart: dayStartOf(FIXTURE_NOW) });
    render(<InFlightOrbits tracks={tracks} now={FIXTURE_NOW} reducedMotion />);
    const [first, second] = [FIXTURE_PAIR.first.name.split(" ")[0], FIXTURE_PAIR.second.name.split(" ")[0]];
    const firstNode = screen.getByRole("button", { name: new RegExp(`^${first}: 2 leaving in flight, 0 delivered here today, about \\$3,000.00 in flight`) });
    act(() => firstNode.focus());
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("2 leaving in flight");
    expect(tip).toHaveTextContent("Sent 1 · Final 0 · Proof posted 1 · Delivering 0");
    expect(tip).toHaveTextContent("0 delivered here today");
    expect(tip).toHaveTextContent("≈ $3,000.00 in flight");
    act(() => firstNode.blur());
    expect(screen.queryByRole("tooltip")).toBeNull();
    const secondNode = screen.getByRole("button", { name: new RegExp(`^${second}: 1 leaving in flight, 1 delivered here today`) });
    fireEvent.pointerEnter(secondNode);
    expect(screen.getByRole("tooltip")).toHaveTextContent("1 delivered here today");
    fireEvent.pointerLeave(secondNode);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("draws each planet as its token's icon from one shared pattern per token, with a lettered disc until it loads or if it fails", () => {
    const tracks = orbitTracks({ pair: FIXTURE_PAIR, inFlight: [row(1, "sent"), row(2, "covered"), row(3, "sent", "second-to-first")], delivered: [], priceOf: () => 1, now: FIXTURE_NOW, dayStart: dayStartOf(FIXTURE_NOW), iconOf: (token) => `https://icons.test/${token.symbol}.png` });
    const { container } = render(<InFlightOrbits tracks={tracks} now={FIXTURE_NOW} reducedMotion />);
    const patterns = container.querySelectorAll("defs pattern");
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.querySelector("image")).toHaveAttribute("href", "https://icons.test/USDC.png");
    const planets = [...container.querySelectorAll<SVGGElement>(".zb-orb-planet")];
    expect(planets.every((planet) => planet.querySelector(".zb-orb-img")?.getAttribute("fill") === `url(#${patterns[0]!.id})`)).toBe(true);
    expect(planets.map((planet) => planet.dataset.icon)).toEqual(["loading", "loading", "loading"]);
    expect(planets[0]!.querySelector(".zb-orb-letter")).toHaveTextContent("U");
    fireEvent.load(patterns[0]!.querySelector("image")!);
    expect(planets.map((planet) => planet.dataset.icon)).toEqual(["ok", "ok", "ok"]);
    fireEvent.error(patterns[0]!.querySelector("image")!);
    expect(planets[0]!.dataset.icon).toBe("failed");
    // A bigger transfer is a bigger planet.
    expect(planets[0]!.querySelector(".zb-orb-body")!.getAttribute("r")).toBe("11.90");
  });

  it("runs the top lane out left to right and the bottom lane back right to left", () => {
    const { container } = render(<InFlightOrbits tracks={tracksOf([row(1, "sent"), row(3, "sent", "second-to-first")])} now={FIXTURE_NOW} reducedMotion />);
    const suns = (lane: number) => [...container.querySelectorAll(`[data-sun][data-lane="${lane}"]`)].map((sun) => ({ x: Number(sun.getAttribute("cx")), y: Number(sun.getAttribute("cy")) }));
    const [top, bottom] = [suns(0), suns(1)];
    expect(top.map((sun) => sun.x)).toEqual([...top.map((sun) => sun.x)].sort((a, b) => a - b));
    expect(bottom.map((sun) => sun.x)).toEqual([...bottom.map((sun) => sun.x)].sort((a, b) => b - a));
    expect(top[0]!.y).toBeLessThan(bottom[0]!.y);
    // Each direction's planet sits on its own lane.
    const yOf = (n: number) => Number(/translate\([-\d.]+ ([-\d.]+)\)/.exec(document.querySelector(`[data-id="${id(n)}"]`)!.getAttribute("transform")!)![1]);
    expect(Math.abs(yOf(1) - top[0]!.y)).toBeLessThan(60);
    expect(Math.abs(yOf(3) - bottom[0]!.y)).toBeLessThan(60);
    // Step labels: above the top lane, below the bottom lane.
    const labels = [...container.querySelectorAll<SVGTextElement>(".zb-orb-label")];
    expect(labels).toHaveLength(8);
    expect(Number(labels[0]!.getAttribute("y"))).toBeLessThan(top[0]!.y);
    expect(Number(labels[4]!.getAttribute("y"))).toBeGreaterThan(bottom[0]!.y);
  });

  it("sends a delivered planet into its destination chain's node, where it fades out", () => {
    const callbacks: ((time: number) => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => (callbacks.push(callback), callbacks.length));
    const { rerender, container } = render(<InFlightOrbits tracks={tracksOf([row(9, "covered")])} now={FIXTURE_NOW} reducedMotion={false} />);
    const destination = container.querySelector<SVGCircleElement>(`.zb-orb-node[data-chain="${FIXTURE_PAIR.second.chainId}"]`)!;
    const target = { x: Number(destination.getAttribute("cx")), y: Number(destination.getAttribute("cy")) };
    rerender(<InFlightOrbits tracks={tracksOf([])} now={FIXTURE_NOW} reducedMotion={false} />);
    let time = performance.now();
    let last = "";
    for (let frame = 0; frame < 400 && document.querySelector(`[data-id="${id(9)}"]`) !== null; frame++) {
      last = document.querySelector(`[data-id="${id(9)}"]`)!.getAttribute("transform") ?? "";
      act(() => callbacks.shift()?.((time += 16)));
    }
    expect(document.querySelector(`[data-id="${id(9)}"]`)).toBeNull();
    const [, x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(last)!;
    expect(Math.hypot(Number(x) - target.x, Number(y) - target.y)).toBeLessThan(10);
  });

  it("with reduced motion, places planets still and never starts a frame loop", () => {
    render(<InFlightOrbits tracks={tracksOf([row(1, "sent"), row(2, "waiting_for_finality")])} now={FIXTURE_NOW} reducedMotion />);
    expect(frames).not.toHaveBeenCalled();
    const planet = document.querySelector(".zb-orb-planet")!;
    expect(planet.getAttribute("transform")).toMatch(/^translate\(/);
    expect(planet.getAttribute("opacity")).not.toBe("0.00");
  });

  it("draws a sun per step among the planets by depth, and a faint path per orbit behind them", () => {
    const rows = Array.from({ length: 6 }, (_, index) => row(50 + index, "sent"));
    const { container } = render(<InFlightOrbits tracks={tracksOf(rows)} now={FIXTURE_NOW} reducedMotion />);
    const svg = container.querySelector("svg.zb-orb-svg")!;
    expect(svg.querySelectorAll("[data-sun]")).toHaveLength(8);
    expect(svg.querySelectorAll(".zb-orb-path")).toHaveLength(1);
    // Planets behind the sun (scaled below 1) come before the suns in the layer; those in front come after.
    const layer = svg.querySelector("[data-sun]")!.parentElement!;
    const kids = [...layer.children];
    const firstSun = kids.findIndex((node) => node.hasAttribute("data-sun"));
    const scaleOf = (node: Element): number => Number(/scale\(([-\d.]+)\)/.exec(node.getAttribute("transform") ?? "")?.[1]);
    expect(kids.slice(0, firstSun).every((node) => scaleOf(node) < 1)).toBe(true);
    expect(kids.slice(firstSun + 4).every((node) => scaleOf(node) >= 1)).toBe(true);
    expect(firstSun).toBeGreaterThan(0);
  });

  it("keeps only the step under the pointer open: moving from a top-lane step to a bottom-lane step closes the top one", () => {
    const rows = [...Array.from({ length: 6 }, (_, index) => row(60 + index, "sent")), ...Array.from({ length: 6 }, (_, index) => row(70 + index, "sent", "second-to-first"))];
    const { container } = render(<InFlightOrbits tracks={tracksOf(rows)} now={FIXTURE_NOW} reducedMotion />);
    const svg = container.querySelector<SVGSVGElement>("svg.zb-orb-svg")!;
    const [width, height] = svg.getAttribute("viewBox")!.split(" ").slice(2).map(Number) as [number, number];
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) });
    const sun = (lane: number) => container.querySelector(`[data-sun="0"][data-lane="${lane}"]`)!;
    const path = (lane: number) => container.querySelector(`[data-lane="${lane}"] .zb-orb-path`)!;
    const restRx = Number(path(0).getAttribute("rx"));
    // Over the top lane's Sent step, and a planet there (which freezes it).
    fireEvent.pointerMove(svg, { clientX: Number(sun(0).getAttribute("cx")), clientY: Number(sun(0).getAttribute("cy")) });
    fireEvent.pointerEnter(container.querySelector(`[data-id="${id(60)}"]`)!);
    expect(Number(path(0).getAttribute("rx"))).toBeGreaterThan(restRx);
    // Straight over to the bottom lane's Sent step: the top one closes, the bottom one opens.
    fireEvent.pointerMove(svg, { clientX: Number(sun(1).getAttribute("cx")), clientY: Number(sun(1).getAttribute("cy")) });
    expect(Number(path(0).getAttribute("rx"))).toBeCloseTo(restRx);
    expect(Number(path(1).getAttribute("rx"))).toBeGreaterThan(restRx);
  });

  it("without reduced motion, runs one frame loop for the loop", () => {
    render(<InFlightOrbits tracks={tracksOf([row(1, "sent"), row(3, "sent", "second-to-first")])} now={FIXTURE_NOW} reducedMotion={false} />);
    expect(frames).toHaveBeenCalledTimes(1);
  });

  it("pauses the loop while the tab is hidden", () => {
    render(<InFlightOrbits tracks={tracksOf([row(1, "sent")])} now={FIXTURE_NOW} reducedMotion={false} />);
    const cancel = window.cancelAnimationFrame as unknown as ReturnType<typeof vi.fn>;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(cancel).toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("keeps a list of the same transfers for screen readers, shown by the toggle, each linking to its message", async () => {
    render(<InFlightOrbits tracks={tracksOf([row(1, "sent"), row(2, "covered")])} now={FIXTURE_NOW} reducedMotion />);
    const list = screen.getAllByRole("list", { name: /transfers in flight/ })[0]!;
    expect(list).toHaveClass("zb-visually-hidden");
    const links = within(list).getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", `#/message/${id(1)}`);
    expect(links[0]).toHaveTextContent(/1500 USDC .*to 0xabcd…1234.*Sent, waiting for finality.*sent 3 min ago/);
    expect(links[1]).toHaveTextContent(/Proof posted, waiting for a deliverer/);
    await userEvent.click(screen.getByRole("button", { name: "Show as a list" }));
    expect(screen.getAllByRole("list", { name: /transfers in flight/ })[0]).toHaveClass("zb-orb-list");
    expect(screen.getByRole("button", { name: "Show as orbits" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the tooltip on keyboard focus and opens the message page on Enter or a click", () => {
    render(<InFlightOrbits tracks={tracksOf([row(7, "sent")])} now={FIXTURE_NOW} reducedMotion />);
    const planet = document.querySelector<SVGGElement>(".zb-orb-planet")!;
    expect(planet).toHaveAttribute("tabindex", "0");
    expect(planet.getAttribute("aria-label")).toMatch(/1500 USDC/);
    act(() => planet.focus());
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent(/1500 USDC/);
    expect(tip).toHaveTextContent(/At: Sent · 3 min since sent/);
    expect(tip).toHaveTextContent(/left|any moment/i);
    fireEvent.keyDown(planet, { key: "Enter" });
    expect(window.location.hash).toBe(`#/message/${id(7)}`);
    window.location.hash = "#/explore";
    fireEvent.click(planet);
    expect(window.location.hash).toBe(`#/message/${id(7)}`);
    act(() => planet.blur());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows the loop with an empty line when nothing is in flight", () => {
    render(<InFlightOrbits tracks={tracksOf([])} now={FIXTURE_NOW} reducedMotion />);
    expect(screen.getAllByText("Nothing in flight right now")).toHaveLength(1);
    expect(document.querySelectorAll(".zb-orb-track")).toHaveLength(1);
  });

  it("labels the steps that hold more planets than are drawn", () => {
    const many = Array.from({ length: 63 }, (_, index) => row(100 + index, "sent"));
    render(<InFlightOrbits tracks={tracksOf(many)} now={FIXTURE_NOW} reducedMotion />);
    expect(document.querySelectorAll(".zb-orb-planet")).toHaveLength(60);
    expect(document.querySelector(".zb-orb-more")).toHaveTextContent("+3 more");
  });
});
