import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CutoverFacts, SealOffer } from "@zk-bridge/shared";
import { FIXTURE_NOW, FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import type { Services } from "../../src/app/services";
import { ForkCutoverLine, forkPauseOf } from "../../src/fork/ForkCutoverLine";
import { ForkPanel } from "../../src/fork/ForkPanel";
import type { ForkChainState, ForkPort } from "../../src/fork/fork-port";
import { useClockSeconds, useForkCutover } from "../../src/fork/use-fork";
import { connectedWallet, disconnectedWallet, renderWithWallet, walletWrapper } from "../app/support";

const NOW = FIXTURE_NOW;
const SOURCE = FIXTURE_PAIR.first;
const DESTINATION = FIXTURE_PAIR.second;
const FORK_EPOCH = 100;
const EPOCH_SECONDS = 384;

/** Facts for a Fulu fork `secondsAway` from the page clock, with the head of the light client on the destination. */
const factsFor = (secondsAway: number, head: bigint | null = 3_000n): CutoverFacts => ({
  destinationChainId: DESTINATION.chainId,
  lightClientHead: head,
  source: {
    kind: "known",
    forks: [{ version: "0x90000075", epoch: FORK_EPOCH, name: "Fulu" }],
    clock: { genesisTime: NOW + secondsAway - FORK_EPOCH * EPOCH_SECONDS, secondsPerSlot: 12, slotsPerEpoch: 32 },
  },
});

const unreachable: CutoverFacts = { destinationChainId: DESTINATION.chainId, lightClientHead: 3_000n, source: { kind: "unreachable", reason: "no answer" } };

const portOf = (over: Partial<ForkPort> = {}): ForkPort => ({
  facts: async () => null,
  chainState: async () => ({ gate: null, observation: null }),
  sealOffer: async () => ({ kind: "unavailable", reason: "none" }),
  ...over,
});

const liveConnection = { resolved: () => ({ rpcUrls: {}, indexerUrl: null, backendUrl: null, archiveUrl: null }), chainAccess: {} } as unknown as Services["connection"];

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.useRealTimers());

describe("the Bridge button before a fork", () => {
  const open = (facts: CutoverFacts | null) => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}`);
    return renderWithWallet(<Shell />, { wallet: connectedWallet(), services: { forks: portOf({ facts: async (chainId) => (chainId === SOURCE.chainId ? facts : null) }) } });
  };

  it("is disabled in the window, and says what happens with the numbers", async () => {
    open(factsFor(600));
    const button = await screen.findByRole("button", { name: /Ethereum sends paused for the Fulu fork/ });
    expect(button).toBeDisabled();
    const line = screen.getByText(/Sends from Ethereum are paused since/);
    expect(line).toHaveTextContent("the Fulu fork (epoch 100) starts in 10m 00s");
    expect(line).toHaveTextContent("They resume once PulseChain's light client's finalized head is past slot 3200; it is slot 3000 now.");
    expect(screen.queryByTestId("fork-cutover-line")).toBeNull();
  });

  it("counts down to the pause before the window and keeps the button as it was", async () => {
    open(factsFor(3 * 3600));
    const line = await screen.findByTestId("fork-cutover-line");
    expect(within(line).getByTestId("fork-cutover-countdown")).toHaveTextContent("Sends pause in 2h 00m");
    expect(line).toHaveTextContent("1 h before the Fulu fork (epoch 100)");
    expect(screen.queryByRole("button", { name: /sends paused/ })).toBeNull();
  });

  it("says nothing of a fork more than a week away", async () => {
    open(factsFor(8 * 86_400));
    await screen.findByRole("button", { name: /Enter an amount|Bridge/ });
    await waitFor(() => expect(screen.queryByTestId("fork-cutover-line")).toBeNull());
  });

  it("warns, and still offers the send, when the beacon node did not answer", async () => {
    open(unreachable);
    const line = await screen.findByTestId("fork-cutover-line");
    expect(line).toHaveAttribute("data-kind", "unknown");
    expect(line).toHaveTextContent("Ethereum's beacon node did not answer, so the next fork of Ethereum is not known. Sends are offered");
    expect(screen.queryByRole("button", { name: /sends paused/ })).toBeNull();
  });

  it("shows nothing when no facts are read", async () => {
    open(null);
    await screen.findByRole("button", { name: /Enter an amount|Bridge/ });
    expect(screen.queryByTestId("fork-cutover-line")).toBeNull();
  });
});

describe("ForkCutoverLine and forkPauseOf with no view", () => {
  it("render nothing and no pause", () => {
    const { container } = render(<ForkCutoverLine view={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(forkPauseOf(null, "Ethereum")).toBeNull();
  });

  it("render nothing for a light client head that could not be read before the fork is near", () => {
    const verdict = { kind: "open", next: null, pausesAt: null, secondsToPause: null } as const;
    const { container } = render(<ForkCutoverLine view={{ sourceChainId: 1, destinationChainId: 2, verdict, text: { headline: null, countdown: null, sendable: true }, nowSeconds: 0 }} />);
    expect(container).toBeEmptyDOMElement();
    const open = { kind: "open", next: { version: "0x01000000", name: "Altair", epoch: 5, slot: 160, time: 100 }, pausesAt: null, secondsToPause: null } as const;
    const { container: second } = render(<ForkCutoverLine view={{ sourceChainId: 1, destinationChainId: 2, verdict: open, text: { headline: "x", countdown: null, sendable: true }, nowSeconds: 0 }} />);
    expect(second).toBeEmptyDOMElement();
    const paused = { kind: "paused", destinationChainId: 2, fork: open.next, pausedSince: 1, lightClientHead: null, leadSeconds: 3600 } as const;
    expect(forkPauseOf({ sourceChainId: 1, destinationChainId: 2, verdict: paused, text: { headline: null, countdown: null, sendable: false }, nowSeconds: 0 }, "Ethereum")).toBeNull();
  });
});

describe("the clock of the fork hooks", () => {
  it("moves with its tick, and decides the verdict again from the facts it holds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const elapsed = { seconds: 0 };
    const wrapper = walletWrapper({ wallet: connectedWallet(), services: { forks: portOf({ facts: async () => factsFor(3_700) }), now: () => NOW + elapsed.seconds } });
    const { result } = renderHook(() => ({ clock: useClockSeconds(1_000), view: useForkCutover(SOURCE.chainId, 1_000) }), { wrapper });
    await vi.waitFor(() => expect(result.current.view?.verdict.kind).toBe("open"));
    elapsed.seconds = 150;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(result.current.view?.verdict.kind).toBe("paused"));
    expect(result.current.clock).toBe(NOW + 150);
  });
});

const GATE = "0x1111111111111111111111111111111111111111" as const;
const REGISTRY = "0x2222222222222222222222222222222222222222" as const;
const state = (over: Partial<ForkChainState["gate"] & object> = {}, observed = true): ForkChainState => ({
  gate: { gate: GATE, mode: "enforcing", enforcing: true, sealed: false, forkRegistry: null, ...over },
  observation: observed ? { registry: REGISTRY, version: "0x90000075", shape: 6, slot: 77n, shapeAllowed: true, observed: true } : null,
});
const ready: SealOffer = { kind: "ready", call: { to: GATE, data: "0x1234" }, evidence: "0x", gas: 90_000n, via: "registry" };

const renderPanel = (port: ForkPort, wallet = connectedWallet()) => renderWithWallet(<ForkPanel pair={FIXTURE_PAIR} />, { wallet, services: { forks: port, connection: liveConnection } });

describe("the Forks section of Explore", () => {
  it("shows nothing on the sample page, which reads no chain", () => {
    const { container } = renderWithWallet(<ForkPanel pair={FIXTURE_PAIR} />, { wallet: connectedWallet() });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows each route with its next fork, its pause and the head of the light client, and each chain's gate and registry in full", async () => {
    renderPanel(portOf({ facts: async (chainId) => factsFor(chainId === SOURCE.chainId ? 3 * 3600 : 8 * 86_400), chainState: async () => state() }));
    const route = await screen.findByTestId(`fork-route-${SOURCE.chainId}`);
    expect(route).toHaveAttribute("data-status", "open");
    expect(within(route).getByTestId("fork-next")).toHaveTextContent(/^Fulu, epoch 100, .* UTC, in 3h 00m$/);
    expect(within(route).getByTestId("fork-pause")).toHaveTextContent(/^at .* UTC, in 2h 00m$/);
    const chain = await screen.findByTestId(`fork-chain-${SOURCE.chainId}`);
    expect(within(chain).getByTestId("fork-gate")).toHaveTextContent("not sealed, mode enforcing, enforcing");
    expect(within(chain).getByTestId("fork-observation")).toHaveTextContent("version 0x90000075, shape 6 (allowed), slot 77");
    expect(within(chain).getByRole("button", { name: `Copy the ${SOURCE.name} gate address` })).toHaveTextContent(GATE);
    expect(within(chain).getByRole("button", { name: `Copy the ${SOURCE.name} fork registry address` })).toHaveTextContent(REGISTRY);
    expect(within(chain).getByTestId("fork-observe-note")).toHaveTextContent("The prover service offers none yet");
  });

  it("shows a paused route with the head of the light client", async () => {
    renderPanel(portOf({ facts: async (chainId) => (chainId === SOURCE.chainId ? factsFor(600) : null) }));
    const route = await screen.findByTestId(`fork-route-${SOURCE.chainId}`);
    expect(route).toHaveAttribute("data-status", "paused");
    expect(within(route).getByText("finalized head slot 3000")).toBeInTheDocument();
    expect(within(route).getByTestId("fork-pause")).toHaveTextContent("resumes once PulseChain's light client head is past slot 3200");
  });

  it("offers Seal the gate only when the call simulated without a revert, and opens the review of it", async () => {
    const sealOffer = vi.fn(async () => ready);
    renderPanel(portOf({ chainState: async () => state({}, false), sealOffer }));
    const button = await screen.findByTestId("fork-seal", {}, { timeout: 5000 });
    expect(sealOffer).toHaveBeenCalled();
    expect(button).toHaveTextContent(`Seal the ${SOURCE.name} gate`);
    await userEvent.click(button);
    expect(await screen.findByText(`Seal the ${SOURCE.name} deposit gate`)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    await waitFor(() => expect(screen.queryByText(`Seal the ${SOURCE.name} deposit gate`)).toBeNull());
  });

  it("describes beacon evidence of the seal", async () => {
    renderPanel(portOf({ chainState: async () => state({}, false), sealOffer: async () => ({ ...ready, via: "beacon", evidence: "0xab" }) }));
    const chain = await screen.findByTestId(`fork-chain-${SOURCE.chainId}`);
    await within(chain).findByTestId("fork-seal");
    expect(chain).toHaveTextContent("the beacon state has a shape the gate does not allow");
  });

  it("offers nothing when the call would revert, without a wallet account, or when the gate is sealed", async () => {
    const unavailable = vi.fn(async (): Promise<SealOffer> => ({ kind: "unavailable", reason: "x" }));
    const first = renderPanel(portOf({ chainState: async () => state(), sealOffer: unavailable }));
    await screen.findByTestId(`fork-chain-${SOURCE.chainId}`);
    await waitFor(() => expect(unavailable).toHaveBeenCalled());
    expect(screen.queryByTestId("fork-seal")).toBeNull();
    first.unmount();

    const none = vi.fn(async () => ready);
    const second = renderPanel(portOf({ chainState: async () => state(), sealOffer: none }), disconnectedWallet());
    await screen.findByTestId(`fork-chain-${SOURCE.chainId}`);
    expect(none).not.toHaveBeenCalled();
    expect(screen.queryByTestId("fork-seal")).toBeNull();
    second.unmount();

    const sealed = vi.fn(async () => ready);
    renderPanel(portOf({ chainState: async () => state({ sealed: true }), sealOffer: sealed }));
    await waitFor(() => expect(screen.getAllByTestId("fork-sealed")).toHaveLength(2));
    expect(sealed).not.toHaveBeenCalled();
    expect(screen.queryByTestId("fork-seal")).toBeNull();
  });

  it("shows the registry alone when the gate cannot be read, and nothing for a chain with neither", async () => {
    renderPanel(portOf({ chainState: async (chainId) => (chainId === SOURCE.chainId ? { gate: null, observation: state().observation } : { gate: null, observation: null }) }));
    const chain = await screen.findByTestId(`fork-chain-${SOURCE.chainId}`);
    expect(within(chain).queryByTestId("fork-gate")).toBeNull();
    expect(within(chain).getByTestId("fork-observation")).toBeInTheDocument();
    expect(screen.queryByTestId(`fork-chain-${DESTINATION.chainId}`)).toBeNull();
  });

  it("shows a gate with no registry, with no observation note", async () => {
    renderPanel(portOf({ chainState: async () => state({}, false) }));
    const chain = await screen.findByTestId(`fork-chain-${SOURCE.chainId}`);
    expect(within(chain).queryByTestId("fork-observation")).toBeNull();
    expect(within(chain).queryByTestId("fork-observe-note")).toBeNull();
  });
});
