import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { buildFixtureFeed, FIXTURE_NOW, FIXTURE_PAIR } from "@terminal/data/fixtures";
import { createFixtureIndexerClient } from "../../src/data/fixture-indexer-client";
import type { MessageDetail } from "../../src/data/message-detail";
import { MessageView } from "../../src/views/MessageView";
import { buildTestServices } from "../render";
import { never, renderWithServices } from "./support";

const feed = buildFixtureFeed(FIXTURE_NOW);
const fixtureClient = createFixtureIndexerClient();

// 16.89 USDC from Ethereum to PulseChain, delivered; and a plain call that was delivered.
const tokenItem = feed.find((item) => item.kind === "token" && item.status === "delivered" && item.direction === "first-to-second")!;
const callItem = feed.find((item) => item.kind === "message" && item.status === "delivered")!;

const detailOf = async (id: MessageDetail["id"]): Promise<MessageDetail> => (await fixtureClient.message(id))!;

const renderDetail = (detail: MessageDetail | null) =>
  renderWithServices(<MessageView messageId={detail?.id ?? tokenItem.id} />, { indexer: { ...buildTestServices().indexer, message: async () => detail } });

/** The key/value row whose key is `key`. */
const row = (key: string | RegExp): HTMLElement => screen.getByText(key, { selector: ".zb-k, .zb-k *" }).closest(".zb-kv") as HTMLElement;

describe("the message page, states", () => {
  it("says Loading while the message is in flight", () => {
    renderWithServices(<MessageView messageId={tokenItem.id} />, { indexer: { ...buildTestServices().indexer, message: never } });
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the error when the message does not load", async () => {
    renderWithServices(<MessageView messageId={tokenItem.id} />, {
      indexer: {
        ...buildTestServices().indexer,
        message: async () => {
          throw new Error("indexer down");
        },
      },
    });
    expect(await screen.findByText("The message did not load: indexer down")).toBeInTheDocument();
  });

  it("says that the indexer does not know a message that it has not seen", async () => {
    renderDetail(null);
    expect(await screen.findByText(/The indexer does not know the message/)).toHaveTextContent(tokenItem.id);
  });
});

describe("the message page, a token transfer", () => {
  it("shows the kind, the route, the amount, the message ID and the status in the band", async () => {
    const { container } = renderDetail(await detailOf(tokenItem.id));
    expect(await screen.findByText("Token transfer")).toBeInTheDocument();
    expect(screen.getByLabelText("Ethereum to PulseChain")).toBeInTheDocument();
    expect(container.querySelector(".zb-xband-big")).toHaveTextContent("16.89 USDC");
    expect(container.querySelector(".zb-xband .zb-on-accent")).not.toBeNull();
    expect(screen.getByText("message ID", { exact: false })).toHaveTextContent(`${tokenItem.id.slice(0, 10)}…${tokenItem.id.slice(-4)}`);
    expect(screen.getByText("delivered", { selector: ".zb-xtag" })).toBeInTheDocument();
    expect(screen.getByText("27 min", { selector: ".zb-xtag" })).toBeInTheDocument();
  });

  it("copies the message ID", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderDetail(await detailOf(tokenItem.id));
    await userEvent.click(await screen.findByRole("button", { name: "Copy the message ID" }));
    expect(writeText).toHaveBeenCalledWith(tokenItem.id);
    expect(await screen.findByRole("button", { name: "Message ID copied" })).toBeInTheDocument();
  });

  it("links From and To to their address pages, and puts the chain icon alone on the left and the amount, symbol and token icon on the right", async () => {
    renderDetail(await detailOf(tokenItem.id));
    await screen.findByText("Token transfer");
    expect(within(row("From")).getByRole("link")).toHaveAttribute("href", `#/explore/address/${tokenItem.sender}`);
    expect(within(row("To")).getByRole("link")).toHaveAttribute("href", `#/explore/address/${tokenItem.recipient}`);
    const sent = row(/^Sent on/);
    // The chain stands as an icon alone: its name only in the alt text, never written out.
    expect(within(sent).getByRole("img", { name: "Ethereum" })).toBeInTheDocument();
    expect(sent.textContent).not.toContain("Ethereum");
    expect(within(sent).getByRole("link", { name: "The transaction on Ethereum's explorer" })).toHaveAttribute("target", "_blank");
    expect(sent.querySelector(".zb-xv")).toHaveTextContent(/^16\.89$/);
    expect(sent.querySelector(".zb-xv .zb-tok-icon img.zb-badge")).toBeNull();
    expect(sent.querySelector(".zb-xv > .zb-xsp")).not.toBeNull();
    const received = row(/^Received on/);
    expect(within(received).getByRole("img", { name: "PulseChain" })).toBeInTheDocument();
    expect(received.querySelector(".zb-xv")).toHaveTextContent(/^16\.89$/);
    // The left side is a fixed grid: label, chain icon, link icon, so the icons line up down the rows.
    for (const line of [sent, received]) expect(line.querySelector(".zb-k")).toHaveClass("zb-xkg");
    expect(row("Fee").querySelector(".zb-k")).toHaveClass("zb-xkg");
  });

  it("names the token once, in a Token row of symbol and icon that leads to the token page", async () => {
    renderDetail(await detailOf(tokenItem.id));
    await screen.findByText("Token transfer");
    const token = row("Token");
    expect(token).toHaveTextContent(/^TokenUSDC$/);
    expect(token).toHaveAttribute("href", `#/explore/token/first/${tokenItem.token!.address}`);
    expect(token.querySelector(".zb-tok-icon")).not.toBeNull();
  });

  it("shows the fee as one total that opens, chevron turning down, into delivery gas, proof generation, the tip and the total — each — until the indexer records them", async () => {
    const { container } = renderDetail(await detailOf(tokenItem.id));
    const fee = await screen.findByRole("button", { name: /^Fee/ });
    expect(fee).toHaveAttribute("aria-expanded", "false");
    expect(fee).toHaveTextContent("$—");
    expect(fee.querySelector(".zb-xv")).toHaveTextContent(/^—$/);
    const drawer = container.querySelector(`#${CSS.escape(fee.getAttribute("aria-controls")!)}`)!;
    expect(drawer).toHaveAttribute("aria-hidden", "true");
    expect(drawer.className).toBe("zb-drawer");
    await userEvent.click(fee);
    expect(fee).toHaveAttribute("aria-expanded", "true");
    expect(drawer).toHaveAttribute("aria-hidden", "false");
    expect(drawer.className).toBe("zb-drawer zb-open");
    // The deck line and the motion come from the shared drawer (.zb-drawer-body).
    expect(drawer.querySelector(".zb-drawer-body")).not.toBeNull();
    const parts = within(drawer as HTMLElement);
    expect(parts.getByText(/^Delivery gas ·/).nextSibling).toHaveTextContent("—");
    expect(parts.getByText("Proof generation").nextSibling).toHaveTextContent("—");
    expect(parts.getByText("Tip to the deliverer").nextSibling).toHaveTextContent("—");
    expect(parts.getByText("Total").nextSibling).toHaveTextContent("—");
    // Each part is an amount and a small token icon, never the symbol; the delivery gas names its chain by icon alone.
    expect(drawer.textContent).not.toContain("USDC");
    expect(drawer.querySelectorAll("dd .zb-tok-icon")).toHaveLength(4);
    expect(parts.getByRole("img", { name: "PulseChain" })).toBeInTheDocument();
    await userEvent.click(fee);
    expect(fee).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the fee of a router delivery: the fee and its share, what the recipient received, the account the router paid, the deliverer and the source", async () => {
    const detail = await detailOf(tokenItem.id);
    const transfer = detail.transfer!;
    const decimals = transfer.destinationToken.decimals;
    const unit = 10n ** BigInt(decimals);
    const recipient = "0x00000000000000000000000000000000000000a8";
    const deliverer = "0x00000000000000000000000000000000000000a7";
    const { container } = renderDetail({
      ...detail,
      transfer: { ...transfer, value: 123n * unit / 10n, deliveredValue: 123n * unit / 10n, delivery: { router: "0x00000000000000000000000000000000000000e7", amount: 123n * unit / 10n, fee: 123n * unit / 10_000n, received: 122_877n * unit / 10_000n, deliverer, recipient, source: "logs" } },
    });
    const fee = await screen.findByRole("button", { name: /^Fee/ });
    expect(fee.querySelector(".zb-xv")).toHaveTextContent("0.0123 (0.1%)");
    expect(row(/^Received on/).querySelector(".zb-xv")).toHaveTextContent("12.2877");
    expect(row("To")).toHaveTextContent(/…00a8$/);
    expect(screen.getByText(/12\.3 \S+ sent · 0\.0123 \S+ fee \(0\.1%\) · 12\.2877 \S+ received/)).toBeInTheDocument();
    await userEvent.click(fee);
    const drawer = within(container.querySelector(`#${CSS.escape(fee.getAttribute("aria-controls")!)}`) as HTMLElement);
    expect(drawer.getByText("Tip to the deliverer").nextSibling).toHaveTextContent("0.0123");
    expect(drawer.getByText("Deliverer").nextSibling).toHaveTextContent(/…00a7$/);
    expect(drawer.getByText("Read from").nextSibling).toHaveTextContent("the token transfers of the delivery");
  });

  it("says why a router delivery has no fee figure: a native gas-based fee leaves no log", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail({ ...detail, transfer: { ...detail.transfer!, delivery: { router: "0x00000000000000000000000000000000000000e7", amount: 5n, fee: null, received: null, deliverer: null, recipient: null, source: "terms" } } });
    const fee = await screen.findByRole("button", { name: /^Fee/ });
    expect(fee.querySelector(".zb-xv")).toHaveTextContent(/^—$/);
    expect(row(/^Received on/).querySelector(".zb-xv")).toHaveTextContent("—");
    expect(screen.queryByText(/ sent · /)).toBeNull();
  });

  it("names who delivered it, the steps, and the ERC-20 mediator on each side, never a token mediator", async () => {
    const { container } = renderDetail(await detailOf(tokenItem.id));
    await screen.findByText("Token transfer");
    expect(within(row("Delivered by")).getByRole("link")).toHaveAttribute("href", `#/explore/address/${tokenItem.recipient}`);
    for (const label of ["Sent on Ethereum", "Block final on Ethereum", "Proof posted to PulseChain", "Delivered on PulseChain"]) expect(screen.getByText(label)).toBeInTheDocument();
    const source = row("Source app");
    expect(source).toHaveTextContent(/^Source appERC-20 mediator0x00000000…00A1$/);
    expect(within(source).getByRole("link")).toHaveAttribute("href", `#/explore/contract/${FIXTURE_PAIR.first.chainId}/${FIXTURE_PAIR.first.contracts.tokenMediator}`);
    expect(within(row("Target app")).getByRole("link")).toHaveAttribute("href", `#/explore/contract/${FIXTURE_PAIR.second.chainId}/${FIXTURE_PAIR.second.contracts.tokenMediator}`);
    expect(container.textContent).not.toMatch(/token ?mediator/i);
    expect(row("Nonce")).toHaveTextContent("—");
    expect(screen.queryByText("Gas limit")).toBeNull();
  });

  it("opens the delivery step to its transaction and what it paid out, and the payload to its bytes", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail({ ...detail, deliveredBlockNumber: 4242 });
    const step = await screen.findByRole("button", { name: /Delivered on PulseChain/ });
    await userEvent.click(step);
    const drawer = within(step.closest("li")!);
    expect(drawer.getByText("Paid out").nextSibling).toHaveTextContent("16.89 USDC");
    expect(drawer.getByText("Block").nextSibling).toHaveTextContent("4,242");
    expect(drawer.getByRole("link", { name: "4,242" })).toHaveAttribute("href", `#/explore/block/${FIXTURE_PAIR.second.chainId}/4242`);
    expect(drawer.getByText("Gas").nextSibling).toHaveTextContent("210,000");
    expect(drawer.getByText("Cost").nextSibling).toHaveTextContent(/^0\.00147 PLS · \$0\.0₇441$/);
    const payload = screen.getByRole("button", { name: /^Payload \(100 bytes\), decoded: mint 16\.89 USDC to 0x00000000…abc0$/ });
    expect(payload).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(payload);
    expect(screen.getByText(detail.data!)).toBeInTheDocument();
  });

  it("shows — for what the indexer did not record: the user, the delivered amount and block, who delivered and the payload", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail({ ...detail, executedBy: null, data: null, destinationTransactionHash: null, transfer: { ...detail.transfer!, sender: null, deliveredValue: null } });
    await screen.findByText("Token transfer");
    expect(row("From")).toHaveTextContent(/^From—$/);
    expect(row(/^Received on/).querySelector(".zb-xv")).toHaveTextContent(/^—$/);
    expect(within(row(/^Received on/)).queryByRole("link")).toBeNull();
    expect(row("Delivered by")).toHaveTextContent(/^Delivered by—$/);
    expect(row("Payload")).toHaveTextContent(/^Payload—$/);
    const step = screen.getByRole("button", { name: /Delivered on PulseChain/ });
    await userEvent.click(step);
    for (const key of ["Transaction", "Block", "Paid out"]) expect(within(step.closest("li")!).getByText(key).nextSibling).toHaveTextContent("—");
  });

  it("waits on the steps not reached, offers to prove and deliver it, and names a target that is not the deployment's by its address", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail({ ...detail, status: "waiting_for_finality", coveredByHeadSlot: null, coveredAt: null, deliveredAt: null, destinationTransactionHash: null, executedBy: null, executor: tokenItem.recipient, transfer: { ...detail.transfer!, deliveredValue: null } });
    expect(await screen.findByRole("region", { name: "Proof and delivery" })).toBeInTheDocument();
    expect(screen.getAllByText("waiting", { selector: ".zb-step-time" })).toHaveLength(3);
    expect(row("Target app")).toHaveTextContent(/^Target app0x00000000…ABC0$/);
    expect(within(row("Target app")).getByRole("link")).toHaveAttribute("href", `#/explore/address/${tokenItem.recipient}`);
    expect(screen.queryByText(/\d+ min/, { selector: ".zb-xtag" })).toBeNull();
  });

  it("stops at a release that failed, gives its reason, and offers no retry", async () => {
    const detail = await detailOf(tokenItem.id);
    const { container } = renderDetail({ ...detail, status: "release_failed", releaseFailed: true });
    expect(await screen.findByText("Release failed on PulseChain")).toBeInTheDocument();
    expect(screen.getByText("Reason").nextSibling).toHaveTextContent("the mediator could not release the tokens; final");
    expect(container.querySelector('.zb-trail-drawer[data-tone="error"]')).not.toBeNull();
  });

  it("names a chain that is not in the pair by its identifier", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail({ ...detail, sourceChainId: 56 });
    expect(await screen.findByText("Sent on chain 56")).toBeInTheDocument();
  });
});

describe("the message page, step costs", () => {
  /** A step's own row button (the step list's, not a link elsewhere on the page). */
  const stepButton = async (name: RegExp) =>
    waitFor(() => {
      const found = [...document.querySelectorAll<HTMLButtonElement>("button.zb-trail-row")].find((button) => name.test(button.textContent ?? ""));
      expect(found).toBeDefined();
      return found!;
    });
  it("shows each step's cost only in its open drawer: the coin and its dollars, and the proof's as shared", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail(detail);
    const sent = await stepButton(/^Sent on Ethereum/);
    // Collapsed, the cost is in a hidden drawer; it shows once the step opens.
    expect(screen.getByText(/0\.0₃84 ETH/).closest(".zb-drawer")).toHaveAttribute("aria-hidden", "true");
    await userEvent.click(sent);
    expect(screen.getByText(/0\.0₃84 ETH/).closest(".zb-drawer")).toHaveAttribute("aria-hidden", "false");
    expect(within(sent.closest("li")!).getByText("Cost").nextSibling).toHaveTextContent(/^0\.0₃84 ETH · \$2\.52$/);
    const proof = await stepButton(/posted to PulseChain/);
    await userEvent.click(proof);
    const drawer = within(proof.closest("li")!);
    expect(drawer.getByText("Cost").nextSibling).toHaveTextContent(/^shared · 0\.0105 PLS · \$0\.0₆315 over 3 transfers$/);
    expect(drawer.getByText("Transaction").nextSibling).toHaveTextContent(/^0x3333/);
  });

  it("links the proof step's drawer to the proof when the indexer lists it", async () => {
    const detail = await detailOf(tokenItem.id);
    const services = buildTestServices();
    const proof = { number: 2, chainId: FIXTURE_PAIR.second.chainId, slot: 14_100_000n, headerRoot: `0x${"1".repeat(64)}`, executionBlockHash: `0x${"2".repeat(64)}`, executionBlockNumber: 5n, transactionHash: `0x${"3".repeat(64)}`, blockNumber: 6n, timestamp: 1_792_929_000, gasUsed: 1n, effectiveGasPrice: 1n, costWei: 1n, poster: `0x${"4".repeat(40)}` } as const;
    renderWithServices(<MessageView messageId={detail.id} />, { indexer: { ...services.indexer, message: async () => detail }, explore: { ...services.explore, proofs: async () => [proof] } });
    const step = await stepButton(/^Proof #2 posted to PulseChain/);
    await userEvent.click(step);
    expect(within(step.closest("li")!).getByRole("link", { name: "open" })).toHaveAttribute("href", `#/explore/proof/${FIXTURE_PAIR.second.chainId}/2`);
  });

  it("opens the proof step to its cost even when the proof itself is not listed, without a link to it", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail({ ...detail, coveredByHeadSlot: 1 });
    const proof = await stepButton(/^Proof posted to PulseChain/);
    await userEvent.click(proof);
    const drawer = within(proof.closest("li")!);
    expect(drawer.queryByText("Proof")).toBeNull();
    expect(drawer.getByText("Cost").nextSibling).toHaveTextContent(/^shared · /);
  });

  it("shows — for a step whose cost the indexer has not stored, and the proof step only links without one", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail({ ...detail, costs: { sent: null, delivered: null, proof: null } });
    const sent = await stepButton(/^Sent on Ethereum/);
    await userEvent.click(sent);
    expect(within(sent.closest("li")!).getByText("Cost").nextSibling).toHaveTextContent(/^—$/);
    expect([...document.querySelectorAll("button.zb-trail-row")].some((button) => /posted to PulseChain/.test(button.textContent ?? ""))).toBe(false);
  });
});

describe("the message page, a contract call", () => {
  it("shows the caller, the called contract, the function, the arguments and the gas", async () => {
    const detail = await detailOf(callItem.id);
    renderDetail(detail);
    expect(await screen.findByText("Contract call")).toBeInTheDocument();
    expect(screen.getByText("Message", { selector: ".zb-xband-big" })).toBeInTheDocument();
    expect(screen.getByText("delivered", { selector: ".zb-xtag" })).toBeInTheDocument();
    expect(within(row("From")).getByRole("link")).toHaveAttribute("href", `#/explore/address/${callItem.sender}`);
    expect(within(row("Calls")).getByRole("link")).toHaveAttribute("href", `#/explore/address/${callItem.recipient}`);
    expect(row("Function")).toHaveTextContent(detail.data!.slice(0, 10));
    expect(row("Arguments")).toHaveTextContent("64 bytes");
    expect(screen.getByRole("button", { name: "Payload (68 bytes)" })).toBeInTheDocument();
    expect(screen.queryByText("The message itself")).toBeNull();
  });

  it("names a call the deployment's ABIs decode by its signature, and shows — without a payload", async () => {
    const detail = await detailOf(callItem.id);
    const transfer = await detailOf(tokenItem.id);
    const first = renderDetail({ ...detail, data: transfer.data });
    expect(await screen.findByText(/^handleBridgedTokens\(/)).toBeInTheDocument();
    first.unmount();
    renderDetail({ ...detail, data: null });
    await screen.findByText("Contract call");
    for (const key of ["Function", "Arguments", "Payload"]) expect(row(key)).toHaveTextContent(/—$/);
  });

  it("opens a failed release with a red top line and its reason, and shows the gas that the delivery used", async () => {
    const detail = await detailOf(tokenItem.id);
    const { container } = renderDetail({ ...detail, status: "release_failed", releaseFailed: true });
    const step = await screen.findByRole("button", { name: /Release failed on PulseChain/ });
    expect(step).toHaveAttribute("aria-expanded", "true");
    expect(step.closest("li")).toHaveAttribute("data-state", "now");
    expect(container.querySelector('.zb-trail-drawer[data-tone="error"]')).not.toBeNull();
    expect(screen.getByText("Reason").nextSibling).toHaveTextContent("the mediator could not release the tokens; final");
    expect(screen.getByText("Gas used").nextSibling).toHaveTextContent(/^210,000$/);
  });

  it("shows — for the gas and the cost of a failed release that the indexer has no costs for", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail({ ...detail, status: "release_failed", releaseFailed: true, destinationTransactionHash: null, costs: null });
    await screen.findByText("Release failed on PulseChain");
    await waitFor(() => expect(screen.getByText("Gas used").nextSibling).toHaveTextContent(/^—$/));
    const failed = [...document.querySelectorAll("button.zb-trail-row")].find((button) => /Release failed/.test(button.textContent ?? ""))!;
    expect(within(failed.closest("li")!).getByText("Cost").nextSibling).toHaveTextContent(/^—$/);
  });

  it("says that the call after the delivery failed, and still counts the transfer as delivered", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail({ ...detail, callbackFailed: true });
    const step = await screen.findByRole("button", { name: /Delivered on PulseChain, the call after it failed/ });
    expect(step.closest("li")).not.toHaveAttribute("data-state", "now");
    expect(document.querySelector('.zb-trail-drawer[data-tone="error"]')).toBeNull();
  });
});
