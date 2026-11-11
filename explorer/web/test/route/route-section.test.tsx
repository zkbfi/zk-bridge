import { renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_NOW, FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { SealOffer } from "@zk-bridge/shared";
import { ExploreScreen } from "../../src/explore/ExploreScreen";
import { RouteSection, useSeen } from "../../src/route/RouteSection";
import { connectedWallet, disconnectedWallet, renderWithWallet } from "../app/support";
import { HEAD, lightClientProof, openingProof, registryProof } from "./proofs";
import { StepCard } from "../../src/route/StepCard";
import { jobOf, newWorld, quietForks, renderWorld } from "./harness";
import { MESSAGE, NOW_MS, stepOf } from "./fixtures";

// The review dialog is the transaction sequence's own business (tested with it); here it hands back what the card gave it.
vi.mock("../../src/actions/TransactionDialog", () => ({
  TransactionDialog: ({ steps, onClose, onFinished }: { steps: readonly { plan: { functionName: string } }[]; onClose: () => void; onFinished?: (hash: string) => void }) => (
    <div role="dialog" aria-label="Review">
      <span data-testid="review-calls">{steps.map((step) => step.plan.functionName).join(",")}</span>
      <button type="button" onClick={() => onFinished?.(`0x${"cd".repeat(32)}`)}>finish</button>
      <button type="button" onClick={onClose}>close</button>
    </div>
  ),
}));

const card = async (id: string) => screen.findByTestId(`route-step-${id}`);

describe("the Route section", () => {
  it("shows nothing without a backend", () => {
    renderWithWallet(<RouteSection />, { wallet: connectedWallet() });
    expect(screen.queryByTestId("route-section")).toBeNull();
  });

  it("lists every pending step with its situation and its constraints in numbers", async () => {
    const world = newWorld();
    world.steps = [stepOf("light-client-update"), stepOf("open-deposits", { constraints: { finality: null, gpu: null } })];
    renderWorld(<RouteSection />, world, { wallet: connectedWallet() });
    expect(screen.getByText("Reading the pending steps…")).toBeInTheDocument();
    const lc = await card("light-client-update:first-to-second");
    expect(within(lc).getByRole("heading", { name: "Light client update" })).toBeInTheDocument();
    expect(within(lc).getByTestId("route-situation")).toHaveTextContent("Ethereum's light client on PulseChain is 19 h behind; 3 transfers wait for it; it strands in 8 h");
    expect(within(lc).getByTestId("route-constraint-gpu")).toHaveTextContent("about 1 min on a warm worker");
    expect(within(lc).getByTestId("route-constraint-budget")).toHaveTextContent("$3.40 of the $5.00 GPU budget for this direction is left today.");
    expect(within(lc).getByTestId("route-make")).toHaveTextContent("Make the proof");
    const open = await card("open-deposits:first-to-second");
    expect(within(open).getByTestId("route-constraint-gpu")).toHaveTextContent("built in a few seconds");
    expect(within(open).getByTestId("route-flow-note")).toHaveTextContent("The backend builds the proof in a few seconds.");
    expect(screen.getByTestId("route-section")).toHaveAttribute("id", "route");
  });

  it("scrolls to the section when asked", async () => {
    const world = newWorld();
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    renderWorld(<RouteSection focus />, world, { wallet: connectedWallet() });
    await screen.findByTestId("route-empty");
    expect(scroll).toHaveBeenCalled();
    scroll.mockRestore();
  });

  it("says when nothing is pending, when the read failed, and which reads failed", async () => {
    const world = newWorld();
    world.unread = ["registry-light-client-update"];
    renderWorld(<RouteSection />, world, { wallet: connectedWallet() });
    expect(await screen.findByTestId("route-empty")).toHaveTextContent("Nothing is pending: every step of both directions is posted.");
    expect(screen.getByTestId("route-unread")).toHaveTextContent("1 read of the backend failed (registry-light-client-update); steps from them may be missing.");
    const failing = newWorld();
    failing.stepsStatus = 500;
    renderWorld(<RouteSection />, failing, { wallet: connectedWallet() });
    expect(await screen.findByTestId("route-failed")).toHaveTextContent("The backend did not give the pending steps");
  });

  it("says a read of more than one failure in the plural", async () => {
    const world = newWorld();
    world.unread = ["a", "b"];
    renderWorld(<RouteSection />, world, { wallet: connectedWallet() });
    expect(await screen.findByTestId("route-unread")).toHaveTextContent("2 reads of the backend failed (a, b)");
  });

  it("adds a seal step from the seal offer and posts it from the wallet", async () => {
    const world = newWorld();
    const ready = { kind: "ready", via: "registry", call: { to: "0x00000000000000000000000000000000000000f2", data: "0xabcd" }, evidence: "0x", gas: 90_000n } as unknown as SealOffer;
    const forks = { ...quietForks, chainState: async (chainId: number) => ({ gate: { gate: "0x00000000000000000000000000000000000000f2", sealed: chainId !== FIXTURE_PAIR.first.chainId, mode: "enforcing", forkRegistry: null }, observation: null }), sealOffer: async () => ready } as unknown as typeof quietForks;
    renderWorld(<RouteSection />, world, { wallet: connectedWallet(), services: { forks } });
    const seal = await card(`seal:${FIXTURE_PAIR.first.chainId}`);
    expect(within(seal).getByRole("heading", { name: "Seal the gate" })).toBeInTheDocument();
    expect(within(seal).getByTestId("route-situation")).toHaveTextContent("The Ethereum deposit gate can be sealed now");
    await userEvent.click(within(seal).getByTestId("route-post"));
    expect(await screen.findByTestId("review-calls")).toHaveTextContent("seal");
    await userEvent.click(screen.getByRole("button", { name: "finish" }));
    expect(await within(seal).findByTestId("route-done")).toHaveTextContent(`0x${"cd".repeat(32)}`);
    expect(within(seal).queryByTestId("route-situation")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the guided flow of a light client update", () => {
  const lcStep = () => stepOf("light-client-update");

  it("makes the proof, follows the job and posts it through the review, then says Done with the transaction", async () => {
    const world = newWorld();
    world.steps = [lcStep()];
    world.job = jobOf();
    world.proof = lightClientProof();
    renderWorld(<RouteSection />, world, { wallet: connectedWallet(), services: { readLightClientHead: async () => HEAD } });
    const lc = await card("light-client-update:first-to-second");
    await userEvent.click(within(lc).getByTestId("route-make"));
    expect(world.requests).toEqual([{ pair: FIXTURE_PAIR.id, kind: "light-client-update", subject: "first-to-second" }]);
    expect(await within(lc).findByTestId("route-progress")).toHaveTextContent("Making the proof: 0:30 elapsed, about 1:30 to go.");
    expect(lc).toHaveAttribute("data-phase", "proving");
  });

  it("goes on to post once the job is done", async () => {
    const world = newWorld();
    world.steps = [lcStep()];
    world.job = jobOf({ status: "done" });
    world.proof = lightClientProof();
    renderWorld(<RouteSection />, world, { wallet: connectedWallet(), services: { readLightClientHead: async () => HEAD } });
    const lc = await card("light-client-update:first-to-second");
    await userEvent.click(within(lc).getByTestId("route-make"));
    const post = await within(lc).findByTestId("route-post");
    expect(post).toHaveTextContent("Post it from your wallet");
    expect(within(lc).getByText(/The proof is made\. The review shows the call/)).toBeInTheDocument();
    await userEvent.click(post);
    expect(await screen.findByTestId("review-calls")).toHaveTextContent("update");
    await userEvent.click(screen.getByRole("button", { name: "finish" }));
    expect(await within(lc).findByTestId("route-done")).toHaveTextContent("Done. Your transaction: 0xcdcd");
  });

  it("joins a job that is running and shows it without an expected time", async () => {
    const world = newWorld();
    world.steps = [stepOf("light-client-update", { constraints: { job: { jobId: "job-1", status: "running", startedAt: NOW_MS - 150_000 } } })];
    renderWorld(<RouteSection />, world, { wallet: connectedWallet() });
    const lc = await card("light-client-update:first-to-second");
    expect(await within(lc).findByTestId("route-progress")).toHaveTextContent("Making the proof: 2:30 elapsed.");
    expect(within(lc).getByTestId("route-constraint-job")).toHaveTextContent("you join it");
    expect(within(lc).queryByTestId("route-make")).toBeNull();
  });

  it("says the proof should land any moment once the expected time has passed", async () => {
    const world = newWorld();
    world.steps = [lcStep()];
    world.job = jobOf({ etaAt: NOW_MS - 1000 });
    world.request = { status: 202, body: { jobId: "job-1", joined: true } };
    renderWorld(<RouteSection />, world, { wallet: connectedWallet() });
    await userEvent.click(await screen.findByTestId("route-make"));
    expect(await screen.findByTestId("route-progress")).toHaveTextContent("it should land any moment");
  });

  it("offers to make the proof again when the job failed, with the reason", async () => {
    const world = newWorld();
    world.steps = [lcStep()];
    world.job = jobOf({ status: "failed", error: "the worker stopped" });
    renderWorld(<RouteSection />, world, { wallet: connectedWallet() });
    await userEvent.click(await screen.findByTestId("route-make"));
    expect(await screen.findByTestId("route-flow-note")).toHaveTextContent("The proof could not be made: the worker stopped.");
    expect(screen.getByTestId("route-make")).toHaveTextContent("Make the proof again");
  });

  it("goes straight to posting when the request says the proof is ready", async () => {
    const world = newWorld();
    world.steps = [lcStep()];
    world.request = { status: 202, body: { jobId: "job-1", ready: true } };
    renderWorld(<RouteSection />, world, { wallet: connectedWallet() });
    await userEvent.click(await screen.findByTestId("route-make"));
    expect(await screen.findByTestId("route-post")).toBeInTheDocument();
  });

  it("treats a proof that is made already as ready, and refreshes the list when the step is not pending", async () => {
    const world = newWorld();
    world.steps = [lcStep()];
    world.request = { status: 409, body: { error: "nothing-to-prove", why: "proof-pending" } };
    renderWorld(<RouteSection />, world, { wallet: connectedWallet() });
    await userEvent.click(await screen.findByTestId("route-make"));
    expect(await screen.findByTestId("route-post")).toBeInTheDocument();
    const other = newWorld();
    other.steps = [lcStep()];
    other.request = { status: 409, body: { error: "nothing-to-prove", why: "no-need" } };
    const reads = () => other.reads.filter((path) => path === "/route/steps").length;
    renderWorld(<RouteSection />, other, { wallet: connectedWallet() });
    const makes = await screen.findAllByTestId("route-make");
    expect(reads()).toBe(1);
    await userEvent.click(makes[0]!);
    expect(await screen.findByText("This step is not pending any more.")).toBeInTheDocument();
    await waitFor(() => expect(reads()).toBe(2));
  });

  it("keeps the button off while a limit holds, with the time left, and brings it back", async () => {
    const world = newWorld();
    world.steps = [lcStep()];
    world.request = { status: 429, body: { error: "rate-limited", retryAfterSeconds: 2, why: "gpu-budget" } };
    let clock = FIXTURE_NOW;
    renderWorld(<RouteSection />, world, { wallet: connectedWallet(), services: { now: () => clock } });
    await userEvent.click(await screen.findByTestId("route-make"));
    const note = await screen.findByTestId("route-flow-note");
    expect(note).toHaveTextContent("The 24-hour GPU budget of this direction is used up. It frees in about 2 s. The button comes back in");
    expect(screen.getByTestId("route-make")).toBeDisabled();
    clock += 5;
    await waitFor(() => expect(screen.getByTestId("route-make")).toBeEnabled(), { timeout: 3000 });
  });

  it("says when the backend did not answer the request", async () => {
    const world = newWorld();
    world.steps = [lcStep()];
    world.request = { status: 500, body: {} };
    renderWorld(<RouteSection />, world, { wallet: connectedWallet() });
    await userEvent.click(await screen.findByTestId("route-make"));
    expect(await screen.findByTestId("route-flow-note")).toHaveTextContent("The backend did not take the request. Try again in 1 min.");
  });

  it("asks a wallet to connect before posting", async () => {
    const world = newWorld();
    world.steps = [stepOf("light-client-update", { constraints: { proofReady: true } })];
    const connect = vi.fn(async () => undefined);
    renderWorld(<RouteSection />, world, { wallet: disconnectedWallet({ connect }) });
    const post = await screen.findByTestId("route-post");
    expect(post).toHaveTextContent("Connect a wallet to post it");
    await userEvent.click(post);
    expect(connect).toHaveBeenCalled();
  });

  it("says a head that moved past the proof was posted by someone else, and stops", async () => {
    const world = newWorld();
    world.steps = [stepOf("light-client-update", { constraints: { proofReady: true } })];
    world.proof = lightClientProof();
    renderWorld(<RouteSection />, world, { wallet: connectedWallet(), services: { readLightClientHead: async () => HEAD + 64n } });
    await userEvent.click(await screen.findByTestId("route-post"));
    const elsewhere = await screen.findByTestId("route-elsewhere");
    expect(elsewhere).toHaveTextContent("Someone else posted this step");
    expect(elsewhere).toHaveTextContent(`The light client already holds slot ${HEAD + 64n}`);
    expect(screen.queryByTestId("route-post")).toBeNull();
  });

  it("says no proof is held when the proof read fails", async () => {
    const world = newWorld();
    world.steps = [stepOf("light-client-update", { constraints: { proofReady: true } })];
    world.proofStatus = 500;
    renderWorld(<RouteSection />, world, { wallet: connectedWallet() });
    await userEvent.click(await screen.findByTestId("route-post"));
    expect(await screen.findByTestId("route-post-note")).toHaveTextContent("The backend holds no finished proof");
  });

  it("says why a post cannot go on, and lets the visitor try again", async () => {
    const world = newWorld();
    world.steps = [stepOf("light-client-update", { constraints: { proofReady: true } })];
    renderWorld(<RouteSection />, world, { wallet: connectedWallet() });
    await userEvent.click(await screen.findByTestId("route-post"));
    expect(await screen.findByTestId("route-post-note")).toHaveTextContent("The backend holds no finished proof for this step now. Make the proof again.");
    expect(screen.getByTestId("route-post")).toBeEnabled();
  });
});

describe("the Route section on Explore", () => {
  it("opens on the section when the link names it, next to the Forks section", async () => {
    const world = newWorld();
    world.steps = [stepOf("open-deposits")];
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    renderWorld(<ExploreScreen route={{ name: "explore", section: "route" }} onRoute={() => undefined} />, world, { wallet: connectedWallet() });
    const section = await screen.findByTestId("route-section");
    expect(within(section).getByRole("heading", { name: /Route/ })).toBeInTheDocument();
    await within(section).findByTestId("route-step-open-deposits:first-to-second");
    expect(scroll).toHaveBeenCalled();
    scroll.mockRestore();
  });
});

describe("a card without a backend", () => {
  it("says the request was not taken and that no proof is held", async () => {
    const make = stepOf("light-client-update");
    const first = renderWithWallet(<StepCard step={make} pending={make} steps={[]} />, { wallet: connectedWallet() });
    await userEvent.click(screen.getByTestId("route-make"));
    expect(await screen.findByTestId("route-flow-note")).toHaveTextContent("The backend did not take the request.");
    first.unmount();
    const ready = stepOf("light-client-update", { constraints: { proofReady: true, job: { jobId: "j", status: "done", startedAt: NOW_MS } } });
    renderWithWallet(<StepCard step={ready} pending={ready} steps={[]} />, { wallet: connectedWallet() });
    await userEvent.click(screen.getByTestId("route-post"));
    expect(await screen.findByTestId("route-post-note")).toHaveTextContent("The backend holds no finished proof");
  });

  it("follows a job it cannot read as running", async () => {
    const running = stepOf("light-client-update", { constraints: { job: { jobId: "j", status: "running", startedAt: NOW_MS - 1000 } } });
    renderWithWallet(<StepCard step={running} pending={running} steps={[]} />, { wallet: connectedWallet() });
    expect(await screen.findByTestId("route-progress")).toHaveTextContent("0:01 elapsed");
  });
});

describe("the other kinds", () => {
  it("posts the opening of deposits and the update of the registry light client from the finished proof", async () => {
    const world = newWorld();
    world.steps = [stepOf("open-deposits", { constraints: { proofReady: true } }), stepOf("registry-light-client-update", { constraints: { proofReady: true } })];
    const registryOf = async () => ({ registry: "0x00000000000000000000000000000000000000f1" as const, lightClient: "0x00000000000000000000000000000000000000d9" as const });
    renderWorld(<RouteSection />, world, { wallet: connectedWallet(), services: { forks: { ...quietForks, registryOf } } });
    const open = await card("open-deposits:first-to-second");
    world.proof = openingProof();
    await userEvent.click(within(open).getByTestId("route-post"));
    expect(await screen.findByTestId("review-calls")).toHaveTextContent("openDeposits");
    await userEvent.click(screen.getByRole("button", { name: "close" }));
    const registry = await card(`registry-light-client-update:${FIXTURE_PAIR.second.chainId}`);
    world.proof = registryProof();
    await userEvent.click(within(registry).getByTestId("route-post"));
    expect(await screen.findByTestId("review-calls")).toHaveTextContent("update");
  });

  it("posts a fork observation from the offer that the Forks section uses", async () => {
    const world = newWorld();
    world.steps = [stepOf("fork-observation", { target: "0x00000000000000000000000000000000000000f1", constraints: { proofReady: true } })];
    const observeOffer = vi.fn(async () => ({ kind: "unavailable", reason: "no newer slot" }) as never);
    renderWorld(<RouteSection />, world, { wallet: connectedWallet(), services: { forks: { ...quietForks, observeOffer, registryOf: async () => ({ registry: "0x00000000000000000000000000000000000000f1", lightClient: "0x00000000000000000000000000000000000000d9" }) } } });
    await userEvent.click(await screen.findByTestId("route-post"));
    expect(await screen.findByTestId("route-post-note")).toHaveTextContent("The observation would not go through now: no newer slot.");
    expect(observeOffer).toHaveBeenCalled();
  });

  it("shows a delivery with its transfer id as a link and a copy control", async () => {
    const world = newWorld();
    world.steps = [stepOf("deliver", { situation: { layoutRows: 1 }, constraints: { gpu: null } })];
    renderWorld(<RouteSection />, world, { wallet: connectedWallet() });
    const delivery = await card(`deliver:${MESSAGE}`);
    expect(within(delivery).getByRole("button", { name: "Copy message ID" })).toHaveTextContent(MESSAGE);
    expect(within(delivery).getByRole("link", { name: "Open the transfer" })).toHaveAttribute("href", `#/message/${MESSAGE}`);
  });
});

describe("a step that leaves the list", () => {
  const listed = [stepOf("open-deposits")];

  it("stays as posted by someone else, once the newest read no longer lists it", () => {
    const { result, rerender } = renderHook(({ steps, unread }) => useSeen(steps, unread), { initialProps: { steps: listed, unread: [] as string[] } });
    expect(result.current).toEqual([{ step: listed[0], pending: listed[0] }]);
    rerender({ steps: [], unread: [] });
    expect(result.current).toEqual([{ step: listed[0], pending: null }]);
  });

  it("drops a seal step that left the list while no account is connected, and keeps it with one", () => {
    const seal = [stepOf("seal")];
    const without = renderHook(({ steps }) => useSeen(steps, [], false), { initialProps: { steps: seal } });
    expect(without.result.current).toHaveLength(1);
    without.rerender({ steps: [] });
    expect(without.result.current).toEqual([]);
    const withAccount = renderHook(({ steps }) => useSeen(steps, [], true), { initialProps: { steps: seal } });
    withAccount.rerender({ steps: [] });
    expect(withAccount.result.current).toEqual([{ step: seal[0], pending: null }]);
  });

  it("stays pending while a read failed, so a missing step is not taken for a posted one", () => {
    const { result, rerender } = renderHook(({ steps, unread }) => useSeen(steps, unread), { initialProps: { steps: listed, unread: [] as string[] } });
    rerender({ steps: [], unread: ["open-deposits"] });
    expect(result.current).toEqual([{ step: listed[0], pending: listed[0] }]);
  });

  it("shows the card as posted by someone else, with nothing left to press", async () => {
    const world = newWorld();
    renderWorld(<StepCard step={listed[0]!} pending={null} steps={[]} />, world, { wallet: connectedWallet() });
    expect(await screen.findByTestId("route-elsewhere")).toHaveTextContent("Someone else posted this step: the backend, the runner or another visitor. Nothing is left to do here.");
    expect(screen.queryByTestId("route-make")).toBeNull();
    expect(screen.queryByTestId("route-post")).toBeNull();
    expect(screen.getByTestId(`route-step-${listed[0]!.id}`)).toHaveAttribute("data-phase", "posted-elsewhere");
  });
});
