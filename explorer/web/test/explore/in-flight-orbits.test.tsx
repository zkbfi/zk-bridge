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
  it("heads each direction with its counts and names the drawing", () => {
    render(<InFlightOrbits tracks={tracksOf([row(1, "sent"), row(2, "covered"), row(3, "sent", "second-to-first")])} now={FIXTURE_NOW} reducedMotion />);
    const [first, second] = [FIXTURE_PAIR.first.name.split(" ")[0], FIXTURE_PAIR.second.name.split(" ")[0]];
    expect(screen.getByText(`· 2 in flight · 0 delivered today`, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: `${first} to ${second}: 2 transfers in flight` })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: `${second} to ${first}: 1 transfer in flight` })).toBeInTheDocument();
    expect(document.querySelectorAll(".zb-orb-planet")).toHaveLength(3);
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
    const svg = container.querySelector(".zb-orb svg")!;
    expect(svg.querySelectorAll("[data-sun]")).toHaveLength(4);
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

  it("without reduced motion, runs one frame loop per track", () => {
    render(<InFlightOrbits tracks={tracksOf([row(1, "sent")])} now={FIXTURE_NOW} reducedMotion={false} />);
    expect(frames).toHaveBeenCalledTimes(2);
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

  it("shows the track with an empty line when nothing is in flight", () => {
    render(<InFlightOrbits tracks={tracksOf([])} now={FIXTURE_NOW} reducedMotion />);
    expect(screen.getAllByText("Nothing in flight right now")).toHaveLength(2);
    expect(document.querySelectorAll(".zb-orb-track")).toHaveLength(2);
  });

  it("labels the steps that hold more planets than are drawn", () => {
    const many = Array.from({ length: 63 }, (_, index) => row(100 + index, "sent"));
    render(<InFlightOrbits tracks={tracksOf(many)} now={FIXTURE_NOW} reducedMotion />);
    expect(document.querySelectorAll(".zb-orb-planet")).toHaveLength(60);
    expect(document.querySelector(".zb-orb-more")).toHaveTextContent("+3");
  });
});
