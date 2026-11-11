import { render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { buildFixtureFeed, FIXTURE_NOW } from "@terminal/data/fixtures";
import { createFixtureIndexerClient } from "../../src/data/fixture-indexer-client";
import type { MessageDetail } from "../../src/data/message-detail";
import { useBlockingStep } from "../../src/route/route-board";
import { RouteNotice } from "../../src/route/RouteNotice";
import { MessageView } from "../../src/views/MessageView";
import { StepTrail } from "../../src/explore/StepTrail";
import { connectedWallet, walletWrapper } from "../app/support";
import { buildTestServices } from "../render";
import { newWorld, quietForks, renderWorld, transportOf, withBackend } from "./harness";
import { stepOf } from "./fixtures";

const feed = buildFixtureFeed(FIXTURE_NOW);
const item = feed.find((candidate) => candidate.kind === "token" && candidate.status === "delivered" && candidate.direction === "first-to-second")!;
const detailOf = async (changes: Partial<MessageDetail>): Promise<MessageDetail> => ({ ...(await createFixtureIndexerClient().message(item.id))!, ...changes });
const waiting = { status: "waiting_for_finality", coveredByHeadSlot: null, coveredAt: null, deliveredAt: null, destinationTransactionHash: null } as const;

const renderMessage = async (changes: Partial<MessageDetail>, steps: ReturnType<typeof stepOf>[]) => {
  const detail = await detailOf(changes);
  const world = newWorld();
  world.steps = steps;
  const base = buildTestServices();
  renderWorld(<MessageView messageId={detail.id} />, world, { wallet: connectedWallet(), services: { indexer: { ...base.indexer, message: async () => detail } } });
  return { detail, world };
};

describe("the transfer timeline", () => {
  it("shows the light client update that holds a waiting transfer up, with its button, under the proof step", async () => {
    await renderMessage(waiting, [stepOf("light-client-update")]);
    const card = await screen.findByTestId("route-step-light-client-update:first-to-second");
    const step = card.closest("li")!;
    expect(within(step).getByRole("button", { name: /Proof posted to PulseChain/ })).toHaveAttribute("aria-expanded", "true");
    expect(within(card).getByTestId("route-make")).toHaveTextContent("Make the proof");
    expect(card).toHaveAttribute("data-placement", "trail");
    // The proof step has its own drawer (the cost) in this fixture: the card comes with it.
    expect(within(step).getByText("Transaction")).toBeInTheDocument();
  });

  it("shows the step of the transfer's own message under the delivery step, and nothing for another message", async () => {
    const detail = await detailOf({ ...waiting, status: "covered", coveredByHeadSlot: 14_100_000, coveredAt: FIXTURE_NOW - 60, costs: null });
    const world = newWorld();
    world.steps = [stepOf("deliver", { messageId: detail.id, subject: detail.id, id: `deliver:${detail.id}` }), stepOf("layout-rows")];
    const base = buildTestServices();
    renderWorld(<MessageView messageId={detail.id} />, world, { wallet: connectedWallet(), services: { indexer: { ...base.indexer, message: async () => detail } } });
    const card = await screen.findByTestId(`route-step-deliver:${detail.id}`);
    expect(card.closest("li")).toHaveTextContent(/Delivered on PulseChain/);
    expect(screen.queryByTestId(`route-step-layout-rows:${stepOf("layout-rows").subject}`)).toBeNull();
  });

  it("shows no card for a transfer that nothing holds up", async () => {
    await renderMessage(waiting, []);
    await screen.findByText(/Proof posted to PulseChain/);
    expect(screen.queryByTestId(/route-step-/)).toBeNull();
  });

  it("keeps the card after the step leaves the list, and says nothing about a post while a read failed", async () => {
    const world = newWorld();
    world.steps = [stepOf("light-client-update")];
    const wrapper = walletWrapper({ wallet: connectedWallet(), services: { endpoints: withBackend, transport: transportOf(world), forks: quietForks } });
    const transfer = { messageId: "0x" + "11".repeat(32), direction: "first-to-second" as const, covered: false };
    const { result, rerender } = renderHook(({ t }) => useBlockingStep(t), { wrapper, initialProps: { t: transfer as typeof transfer | null } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(result.current?.step.id).toBe("light-client-update:first-to-second");
    expect(result.current?.pending?.id).toBe("light-client-update:first-to-second");
    rerender({ t: null });
    expect(result.current?.step.id).toBe("light-client-update:first-to-second");
    expect(result.current?.pending).toBeNull();
  });

  it("keeps the step pending when the list left reads unread", async () => {
    const world = newWorld();
    world.steps = [stepOf("light-client-update")];
    world.unread = ["registry-light-client-update"];
    const wrapper = walletWrapper({ wallet: connectedWallet(), services: { endpoints: withBackend, transport: transportOf(world), forks: quietForks } });
    const transfer = { messageId: "0x" + "11".repeat(32), direction: "first-to-second" as const, covered: false };
    const { result, rerender } = renderHook(({ t }) => useBlockingStep(t), { wrapper, initialProps: { t: transfer as typeof transfer | null } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    rerender({ t: null });
    expect(result.current?.pending?.id).toBe("light-client-update:first-to-second");
  });

  it("does not take a step for posted while the list failed to read", async () => {
    const world = newWorld();
    world.stepsStatus = 500;
    const wrapper = walletWrapper({ wallet: connectedWallet(), services: { endpoints: withBackend, transport: transportOf(world), forks: quietForks } });
    const { result } = renderHook(() => useBlockingStep(null), { wrapper });
    expect(result.current).toBeNull();
  });

  it("opens a drawer that is known after the page loaded, once, unless the reader opened another", async () => {
    const steps = [
      { label: "One", done: true, when: "", drawer: <p>first</p> },
      { label: "Two", done: false, when: "waiting", drawer: <p>second</p> },
    ];
    const view = render(<StepTrail steps={steps} initiallyOpen={null} />);
    expect(screen.getByRole("button", { name: /Two/ })).toHaveAttribute("aria-expanded", "false");
    view.rerender(<StepTrail steps={steps} initiallyOpen={1} />);
    expect(screen.getByRole("button", { name: /Two/ })).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button", { name: /One/ }));
    view.rerender(<StepTrail steps={steps} initiallyOpen={1} />);
    expect(screen.getByRole("button", { name: /One/ })).toHaveAttribute("aria-expanded", "true");
  });
});

describe("the notice of the Bridge screen", () => {
  it("says nothing when no step holds up sends or deliveries", async () => {
    const world = newWorld();
    world.steps = [stepOf("layout-rows")];
    renderWorld(<RouteNotice />, world, { wallet: connectedWallet() });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByTestId("route-notice")).toBeNull();
  });

  it("says what holds them up and links to the Route section", async () => {
    const world = newWorld();
    world.steps = [stepOf("open-deposits", { situation: { blocks: ["sends"] } })];
    renderWorld(<RouteNotice />, world, { wallet: connectedWallet() });
    const notice = await screen.findByTestId("route-notice");
    expect(notice).toHaveTextContent("Deposits on PulseChain are closed until someone posts the opening proof.");
    expect(within(notice).getByRole("link", { name: "Open the route steps" })).toHaveAttribute("href", "#/explore?section=route");
  });
});
