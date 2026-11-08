import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import type { Services } from "../../src/app/services";
import { connectedWallet, renderWithWallet } from "../app/support";
import { buildTestServices } from "../render";

vi.mock("../../src/explore/chain-reader", async (original) => {
  const actual = await original<typeof import("../../src/explore/chain-reader")>();
  const reader = { transaction: async () => { throw new Error("n/a"); }, block: async () => { throw new Error("n/a"); }, verifier: async () => "0xF711000000000000000000000000000000007f67", account: async () => ({ balance: 0n, nonce: 1, isContract: true }) };
  return { ...actual, useChainReader: () => () => reader };
});

const HOUR = 3_600_000;
type Deadlines = { readonly "first-to-second"?: number | null | "absent"; readonly "second-to-first"?: number | null | "absent" };

/** Pipeline answers like the backend's (older fixtures: no `deadline` when "absent"), with deadlines `hours` from now. */
const withBackend = (hours: Deadlines | "down" | "none"): Partial<Services> => {
  const base = buildTestServices();
  if (hours === "none") return {};
  const fetchJson = vi.fn(async (url: string) => {
    if (hours === "down") throw new Error("down");
    const direction = /directions\/(.+)\/pipeline/.exec(url)![1] as "first-to-second" | "second-to-first";
    const left = hours[direction];
    const deadline = left === undefined || left === "absent" ? {} : { deadline: left === null ? null : { at: Date.now() + left * HOUR, hoursLeft: left, period: 17, headSlot: 1, headPeriod: 16 } };
    return { status: 200, body: { direction, now: 1, batch: null, job: null, latestJob: null, latestProof: null, head: null, decision: null, ...deadline } };
  });
  return {
    endpoints: () => ({ ...base.endpoints(), backendUrl: { value: "https://prove.example", source: "environment" } }) as unknown as ReturnType<Services["endpoints"]>,
    transport: { ...base.transport, fetchJson: fetchJson as unknown as Services["transport"]["fetchJson"] },
  };
};

const open = (hash: string, hours: Parameters<typeof withBackend>[0]) => {
  window.history.replaceState(null, "", hash);
  return renderWithWallet(<Shell />, { wallet: connectedWallet(), services: withBackend(hours) });
};

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.useRealTimers());

const card = (title: RegExp) => screen.getByText(title).closest("a") as HTMLElement;

describe("the light-client cards of Explore", () => {
  it("each card shows the time until its own light client strands, in its tone", async () => {
    // The card of Ethereum (it checks PulseChain) belongs to the direction that delivers to Ethereum: second-to-first.
    open("#/explore", { "second-to-first": 5.2, "first-to-second": 31 });
    const eth = await waitFor(() => {
      const found = card(new RegExp(`${FIXTURE_PAIR.first.name} checks`));
      expect(within(found).getByTestId("stranding-line")).toBeInTheDocument();
      return found;
    });
    expect(within(eth).getByTestId("stranding-line")).toHaveTextContent("5.2 h until stranded (period 17)");
    expect(within(eth).getByTestId("stranding-line")).toHaveAttribute("data-tone", "bad");
    const other = card(new RegExp(`${FIXTURE_PAIR.second.name} checks`));
    expect(within(other).getByTestId("stranding-line")).toHaveTextContent("31 h until stranded (period 17)");
    expect(within(other).getByTestId("stranding-line")).toHaveAttribute("data-tone", "normal");
  });

  it("uses the warn tone between 6 and 12 h, and states a passed deadline", async () => {
    open("#/explore", { "second-to-first": 9.5, "first-to-second": -2.1 });
    const line = await waitFor(() => within(card(new RegExp(`${FIXTURE_PAIR.first.name} checks`))).getByTestId("stranding-line"));
    expect(line).toHaveTextContent("9.5 h until stranded (period 17)");
    expect(line).toHaveClass("zb-warn-text");
    const passed = within(card(new RegExp(`${FIXTURE_PAIR.second.name} checks`))).getByTestId("stranding-line");
    expect(passed).toHaveTextContent("Past the stranding point by 2.1 h (period 17)");
    expect(passed).toHaveClass("zb-bad-text");
  });

  it.each([
    ["an older backend without the field", { "first-to-second": "absent", "second-to-first": "absent" } as const],
    ["a backend that does not know the deadline", { "first-to-second": null, "second-to-first": null } as const],
    ["an unreachable backend", "down" as const],
    ["no backend", "none" as const],
  ])("shows no line with %s", async (_name, hours) => {
    open("#/explore", hours);
    await screen.findByRole("heading", { name: /Light clients/ });
    await screen.findByText(new RegExp(`${FIXTURE_PAIR.first.name} checks`));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId("stranding-line")).toBeNull();
  });

  it("keeps counting down from the deadline as the clock moves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open("#/explore", { "second-to-first": 5.2, "first-to-second": 31 });
    const eth = () => within(card(new RegExp(`${FIXTURE_PAIR.first.name} checks`)));
    await waitFor(() => expect(eth().getByTestId("stranding-line")).toHaveTextContent("5.2 h"));
    act(() => { vi.setSystemTime(Date.now() + 2 * HOUR); vi.advanceTimersByTime(60_000); });
    await waitFor(() => expect(eth().getByTestId("stranding-line")).toHaveTextContent("3.2 h until stranded"));
  });
});

describe("the light-client detail page", () => {
  const lightClient = FIXTURE_PAIR.first.contracts.lightClient;

  it("shows the line for the light client on that chain", async () => {
    open(`#/explore/contract/${FIXTURE_PAIR.first.chainId}/${lightClient}`, { "second-to-first": 3.4, "first-to-second": 31 });
    const line = await screen.findByTestId("stranding-line");
    expect(line).toHaveTextContent("3.4 h until stranded (period 17)");
    expect(screen.getByText("Light client strands", { selector: ".zb-k" })).toBeInTheDocument();
  });

  it("hides the row when the deadline is unknown", async () => {
    open(`#/explore/contract/${FIXTURE_PAIR.first.chainId}/${lightClient}`, "down");
    await screen.findByText("Proofs posted to it", { exact: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("Light client strands")).toBeNull();
  });
});

describe("the route menu", () => {
  const openMenu = async (hours: Parameters<typeof withBackend>[0]) => {
    open(`#/bridge/${FIXTURE_PAIR.id}`, hours);
    await userEvent.click(await screen.findByRole("button", { name: /^From .*Change the route/ }));
    return screen.getByRole("menu", { name: "Route" });
  };
  const rowOf = (menu: HTMLElement, from: string, to: string) => within(menu).getAllByRole("menuitemradio").find((item) => item.textContent?.includes(`${from} → ${to}`))!;

  it("notes a light client 6 h or fewer from stranded next to the route, without blocking it", async () => {
    const menu = await openMenu({ "first-to-second": 4.1, "second-to-first": 6.5 });
    await waitFor(() => expect(rowOf(menu, FIXTURE_PAIR.first.name, FIXTURE_PAIR.second.name)).toHaveTextContent("light client 4.1 h from stranded"));
    expect(rowOf(menu, FIXTURE_PAIR.first.name, FIXTURE_PAIR.second.name)).toHaveAttribute("aria-disabled", "false");
    expect(rowOf(menu, FIXTURE_PAIR.second.name, FIXTURE_PAIR.first.name)).not.toHaveTextContent(/stranded|stranding/);
  });

  it("notes a passed deadline", async () => {
    const menu = await openMenu({ "first-to-second": -1, "second-to-first": "absent" });
    await waitFor(() => expect(rowOf(menu, FIXTURE_PAIR.first.name, FIXTURE_PAIR.second.name)).toHaveTextContent("light client is past its stranding point"));
  });

  it("has no note above 6 h", async () => {
    const menu = await openMenu({ "first-to-second": 7, "second-to-first": 30 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(menu).not.toHaveTextContent(/stranded|stranding/);
  });
});
