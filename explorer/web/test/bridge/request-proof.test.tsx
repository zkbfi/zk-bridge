import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FeedItem } from "@terminal/model/types";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { clearPending } from "../../src/bridge/pending";
import { PROOF_STARTING_TEXT, canRequestProof, proofRequestView, waitText } from "../../src/bridge/proof-request";
import { RequestProof } from "../../src/bridge/RequestProof";
import { NO_ENDPOINTS, type PanelTransport } from "../../src/views/proof-panel-model";
import { buildTestServices } from "../render";
import { connectedWallet, renderWithWallet } from "../app/support";

const NOW = 1_800_000_000_000;
const context = { destinationName: "PulseChain", now: NOW };
const BACKEND = "https://prove.example.org";

describe("what a proof request's answer says", () => {
  it("offers a request only for a transfer final on its source and not yet covered", () => {
    expect(canRequestProof("waiting_for_finality")).toBe(true);
    for (const status of ["sent", "covered", "delivered", "release_failed"] as const) expect(canRequestProof(status)).toBe(false);
  });

  it("writes waits in seconds, minutes and hours", () => {
    expect(waitText(0)).toBe("1 s");
    expect(waitText(45)).toBe("45 s");
    expect(waitText(120)).toBe("2 min");
    expect(waitText(324)).toBe("5 min 24 s");
    expect(waitText(3600)).toBe("1 h");
    expect(waitText(13_200)).toBe("3 h 40 min");
  });

  it("a started proof: what happens, with numbers, and the button stays off", () => {
    expect(PROOF_STARTING_TEXT).toBe("A proof is starting. About 1–2 min to prove, then delivery.");
    expect(proofRequestView({ requestId: "r", jobId: "j" }, context)).toEqual({ tone: "ok", text: PROOF_STARTING_TEXT, retryAt: null });
    expect(proofRequestView({ requestId: "r", jobId: "j", joined: true }, context)).toEqual({
      tone: "ok",
      text: "A proof for this direction is already running. If it does not reach this transfer, ask again when it lands, in about 2 min.",
      retryAt: NOW + 120_000,
    });
  });

  it("the backend's refusals, plainly, with the time left", () => {
    expect(proofRequestView({ refused: "rate-limited", retryAfterSeconds: 47 }, context)).toEqual({ tone: "wait", text: "Too many proof requests right now. Try again in 47 s.", retryAt: NOW + 47_000 });
    expect(proofRequestView({ refused: "rate-limited", retryAfterSeconds: 47, why: "limit" }, context).text).toBe("Too many proof requests right now. Try again in 47 s.");
    expect(proofRequestView({ refused: "rate-limited", retryAfterSeconds: 324, why: "same-finality" }, context).text).toBe("A proof to the newest finality is already made or running. The next finality comes in about 5 min 24 s; ask again then.");
    expect(proofRequestView({ refused: "rate-limited", retryAfterSeconds: 13_200, why: "gpu-budget" }, context).text).toBe("The prover's 24-hour GPU budget for this direction is used up. Try again in 3 h 40 min.");
    expect(proofRequestView({ refused: "nothing-to-prove" }, context)).toEqual({ tone: "ok", text: "Already covered: the light client on PulseChain holds a head past this transfer. Delivery follows.", retryAt: null });
    expect(proofRequestView({ refused: "nothing-to-prove", why: "proof-pending" }, context).text).toBe("A proof is already made and is landing on PulseChain. Delivery follows once it lands.");
    expect(proofRequestView({ refused: "cannot-check", retryAfterSeconds: 30 }, context)).toEqual({ tone: "wait", text: "The prover could not check the chain. Try again in 30 s.", retryAt: NOW + 30_000 });
    expect(proofRequestView(null, context)).toEqual({ tone: "error", text: "The prover did not take the request. Try again in 1 min.", retryAt: NOW + 60_000 });
  });
});

describe("Request a proof on the Activity screen", () => {
  const item = (overrides: Partial<FeedItem>): FeedItem =>
    ({
      id: `0x${"01".repeat(32)}`,
      kind: "token",
      direction: "first-to-second",
      status: "waiting_for_finality",
      sender: "0x52908400098527886E0F7030069857D2E4169EE7",
      recipient: "0x52908400098527886E0F7030069857D2E4169EE7",
      token: FIXTURE_TOKENS[0]!,
      amount: 10n ** 18n,
      sentAt: Math.floor(Date.now() / 1000) - 900,
      deliveredAt: null,
      sourceTransactionHash: `0x${"11".repeat(32)}`,
      destinationTransactionHash: null,
      ...overrides,
    }) as FeedItem;

  beforeEach(() => clearPending());
  afterEach(() => clearPending());

  const renderActivity = (options: { items: FeedItem[]; backend: boolean; post?: (body: string) => Promise<{ status: number; body: unknown }> }) => {
    window.history.replaceState(null, "", "#/activity");
    const base = buildTestServices();
    const posts: string[] = [];
    const transport: PanelTransport = {
      fetchJson: async () => ({ status: 404, body: null }),
      postJson: async (url, init) => {
        posts.push(`${url} ${init?.body ?? ""}`);
        return (options.post ?? (async () => ({ status: 202, body: { requestId: "r1", jobId: "j1" } })))(String(init?.body ?? ""));
      },
    };
    renderWithWallet(<Shell />, {
      wallet: connectedWallet(),
      services: {
        dataSource: { ...base.dataSource, getFeed: async () => ({ items: options.items, hasMore: false }) },
        endpoints: () => (options.backend ? { ...NO_ENDPOINTS, backendUrl: { value: BACKEND, source: "default" } } : NO_ENDPOINTS),
        transport,
      },
    });
    return { posts };
  };

  it("asks the prover for a final, uncovered transfer and says what happens; no sign-in", async () => {
    const run = renderActivity({ items: [item({}), item({ id: `0x${"02".repeat(32)}`, status: "sent" })], backend: true });
    const button = await screen.findByRole("button", { name: "Request a proof" });
    // Only the final one offers it.
    expect(screen.getAllByRole("button", { name: "Request a proof" })).toHaveLength(1);
    await userEvent.click(button);
    expect(await screen.findByText(PROOF_STARTING_TEXT)).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(run.posts).toHaveLength(1);
    expect(run.posts[0]).toContain(`${BACKEND}/requests`);
    expect(run.posts[0]).toContain(`"pair":"${FIXTURE_PAIR.id}"`);
    expect(run.posts[0]).toContain('"reason":"message"');
    expect(run.posts[0]).toContain(`"messageId":"0x${"01".repeat(32)}"`);
  });

  it("shows a refusal with the time left, and turns the button back on when the wait is over", async () => {
    renderActivity({ items: [item({})], backend: true, post: async () => ({ status: 429, body: { error: "rate-limited", retryAfterSeconds: 1, why: "same-finality" } }) });
    const button = await screen.findByRole("button", { name: "Request a proof" });
    await userEvent.click(button);
    expect(await screen.findByText("A proof to the newest finality is already made or running. The next finality comes in about 1 s; ask again then.")).toBeInTheDocument();
    expect(button).toBeDisabled();
    // The wait is a real 1 s timer. The wait for it is the default of test/setup.ts (10 s): a 3 s limit here was missed
    // on a busy machine during a full coverage run.
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("says when the prover does not take the request", async () => {
    renderActivity({ items: [item({})], backend: true, post: async () => ({ status: 500, body: null }) });
    await userEvent.click(await screen.findByRole("button", { name: "Request a proof" }));
    expect(await screen.findByText("The prover did not take the request. Try again in 1 min.")).toBeInTheDocument();
  });

  it("is not offered when no prover backend is set", async () => {
    renderActivity({ items: [item({})], backend: false });
    await screen.findByText(/waiting/i);
    expect(screen.queryByRole("button", { name: "Request a proof" })).toBeNull();
  });

  it("the component alone renders nothing without a backend", () => {
    const { container } = renderWithWallet(<RequestProof messageId={`0x${"01".repeat(32)}`} direction="first-to-second" destinationName="PulseChain" />, { wallet: connectedWallet() });
    expect(container.querySelector(".zb-request-proof")).toBeNull();
  });
});
