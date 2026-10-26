import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getAddress, type Hash } from "viem";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { buildMessageSteps } from "@terminal/app/actions";
import { FIXTURE_TRANSACTION_HASH } from "@terminal/chain/chain-access";
import { TransactionDialog } from "../../src/actions/TransactionDialog";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS, type DeliveryOptions } from "../../src/tx/bridge-draft";
import type { WebStep } from "../../src/tx/bridge-steps";
import { buildDeliveryReport, buildFixtureContext } from "../helpers";
import { buildTestServices } from "../render";
import { connectedWallet, renderWithWallet } from "../app/support";
import type { Services } from "../../src/app/services";

const usdc = FIXTURE_TOKENS[0]!;

const stepsOf = async (input: { readonly allowance?: bigint; readonly options?: Partial<DeliveryOptions> } = {}): Promise<readonly WebStep[]> => {
  const { context, tokens } = await buildFixtureContext({ allowance: input.allowance ?? 10n ** 12n });
  const draft = computeBridgeDraft(
    { token: `first:${usdc.address}`, amount: "250", receiver: getAddress(`0x${"cd".repeat(20)}`), mode: "plain", data: "", fallback: "" },
    { ...DEFAULT_DELIVERY_OPTIONS, mode: "none", senderPriceText: "1", ...input.options },
    { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n },
  );
  if (draft.status !== "ready") throw new Error(draft.reason ?? "not ready");
  return draft.steps;
};

/** The fixture services where the receipt of a transaction comes from the given function. */
const servicesWithReceipt = (waitForTransactionReceipt: (parameters: { hash: Hash }) => Promise<{ status: "success" | "reverted"; gasUsed: bigint; blockNumber: bigint }>): Partial<Services> => {
  const base = buildTestServices();
  return { chainAccess: { ...base.chainAccess, flowClient: (chainId) => ({ ...base.chainAccess.flowClient(chainId), waitForTransactionReceipt: (parameters) => waitForTransactionReceipt(parameters) as never }) } };
};

/** The Close button of the footer. The header of the modal has a button with the same name, and it comes first. */
const footerClose = (): HTMLElement => {
  const buttons = screen.getAllByRole("button", { name: "Close" });
  expect(buttons).toHaveLength(2);
  return buttons[1]!;
};

const send = async () => userEvent.click(await screen.findByRole("button", { name: "Send to wallet" }));

describe("the confirm dialog while the wallet works", () => {
  it("tells the user to confirm in the wallet while the wallet holds the transaction, and keeps the review on screen", async () => {
    const sendTransaction = vi.fn(() => new Promise<Hash>(() => undefined));
    renderWithWallet(<TransactionDialog steps={await stepsOf()} onClose={() => undefined} />, { wallet: connectedWallet({ sendTransaction }) });
    await send();
    expect(await screen.findByText(/Confirm in your wallet\. With a hardware wallet, read the screen of the device too\./)).toBeInTheDocument();
    expect(screen.getByTestId("confirm-review")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send to wallet" })).toBeNull();
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("shows the short hash while the page waits for the chain to confirm", async () => {
    const wallet = connectedWallet({ sendTransaction: async () => FIXTURE_TRANSACTION_HASH });
    renderWithWallet(<TransactionDialog steps={await stepsOf()} onClose={() => undefined} />, { wallet, services: servicesWithReceipt(() => new Promise(() => undefined)) });
    await send();
    const notice = await screen.findByText(/^Submitted as /);
    expect(notice).toHaveTextContent(/Submitted as 0x[0-9a-f]+…[0-9a-f]+\. Waiting for the chain to confirm it…/);
    expect(screen.getByTestId("confirm-review")).toBeInTheDocument();
  });
});

describe("the confirm dialog after a failure", () => {
  it("shows why the wallet did not send, closes on Close, and prepares again on Try again", async () => {
    const onClose = vi.fn();
    const sendTransaction = vi.fn().mockRejectedValueOnce(new Error("The viewer rejected the request.")).mockResolvedValue(FIXTURE_TRANSACTION_HASH);
    renderWithWallet(<TransactionDialog steps={await stepsOf()} onClose={onClose} />, { wallet: connectedWallet({ sendTransaction }) });
    await send();
    expect(await screen.findByRole("alert")).toHaveTextContent("Not sent: The viewer rejected the request.");
    expect(screen.queryByTestId("confirm-review")).toBeNull();

    await userEvent.click(footerClose());
    expect(onClose).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await send();
    expect(await screen.findByText(/Done\. Every transaction is confirmed\./)).toBeInTheDocument();
    expect(sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("shows why the transaction could not be prepared", async () => {
    const base = buildTestServices();
    const services: Partial<Services> = { chainAccess: { ...base.chainAccess, flowClient: (chainId) => ({ ...base.chainAccess.flowClient(chainId), estimateGas: async () => Promise.reject(new Error("execution reverted")) }) } };
    renderWithWallet(<TransactionDialog steps={await stepsOf()} onClose={() => undefined} />, { wallet: connectedWallet(), services });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not prepare the transaction: execution reverted");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("offers no second try after a transaction reverted, and lists what was sent", async () => {
    const wallet = connectedWallet({ sendTransaction: async () => FIXTURE_TRANSACTION_HASH });
    const services = servicesWithReceipt(async () => ({ status: "reverted", gasUsed: 1n, blockNumber: 1n }));
    renderWithWallet(<TransactionDialog steps={await stepsOf()} onClose={() => undefined} />, { wallet, services });
    await send();
    expect(await screen.findByRole("alert")).toHaveTextContent(`The transaction ${FIXTURE_TRANSACTION_HASH} reverted.`);
    expect(footerClose()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    const sent = screen.getByText("Sent so far").parentElement!;
    expect(within(sent).getByText("reverted")).toBeInTheDocument();
    expect(within(sent).getByText(FIXTURE_TRANSACTION_HASH)).toBeInTheDocument();
  });
});

describe("the confirm dialog review of a tip", () => {
  it("warns about a router that is not the fee router of the deployment", async () => {
    const other = getAddress(`0x${"ee".repeat(20)}`);
    const steps = await stepsOf({ options: { mode: "percentage", routerText: other } });
    renderWithWallet(<TransactionDialog steps={steps} onClose={() => undefined} />, { wallet: connectedWallet() });
    expect(await screen.findByTestId("confirm-router-warning")).toHaveTextContent("This router is not the fee router of the deployment");
  });

  it("leaves out the cost lines when no coin price is known", async () => {
    const steps = await stepsOf({ options: { mode: "percentage", senderPriceText: null } });
    renderWithWallet(<TransactionDialog steps={steps} onClose={() => undefined} />, { wallet: connectedWallet() });
    const delivery = await screen.findByTestId("confirm-delivery");
    expect(within(delivery).queryByText("Cost lines")).toBeNull();
    expect(within(delivery).getByText("Tip terms in the call data")).toBeInTheDocument();
  });

  it("shows the cost lines when a coin price is known", async () => {
    const steps = await stepsOf({ options: { mode: "percentage", senderPriceText: "1" } });
    renderWithWallet(<TransactionDialog steps={steps} onClose={() => undefined} />, { wallet: connectedWallet() });
    expect(within(await screen.findByTestId("confirm-delivery")).getByText("Cost lines")).toBeInTheDocument();
  });
});

describe("the review of a step with no bridge fee", () => {
  it("shows no bridge fee lines for a message, which pays no fee to the token bridge", async () => {
    const [flowStep] = buildMessageSteps({ chain: "first", target: `0x${"cd".repeat(20)}`, data: "", gas: "200000" }, FIXTURE_PAIR);
    const step: WebStep = { plan: flowStep!.plan, disclosure: { feesApplyTo: "this-transaction", amountToken: null, destinationNativeSymbol: null, destinationChainId: null, bridgeFees: null, delivery: null } };
    renderWithWallet(<TransactionDialog steps={[step]} onClose={() => undefined} />, { wallet: connectedWallet() });
    const review = await screen.findByTestId("confirm-review");
    expect(within(review).getByText("requireToPassMessage(address,bytes,uint256)")).toBeInTheDocument();
    expect(within(review).queryByText(/^Bridge fee/)).toBeNull();
  });
});

describe("the notes of a step", () => {
  it("lists the notes of the plan, and leaves the list out when the plan has none", async () => {
    const steps = await stepsOf();
    const { unmount } = renderWithWallet(<TransactionDialog steps={steps} onClose={() => undefined} />, { wallet: connectedWallet() });
    const review = await screen.findByTestId("confirm-review");
    expect(within(review).getAllByRole("listitem").map((item) => item.textContent)).toEqual(steps[0]!.plan.notes);
    unmount();

    const withoutNotes: readonly WebStep[] = [{ ...steps[0]!, plan: { ...steps[0]!.plan, notes: [] } }];
    renderWithWallet(<TransactionDialog steps={withoutNotes} onClose={() => undefined} />, { wallet: connectedWallet() });
    expect(within(await screen.findByTestId("confirm-review")).queryByRole("listitem")).toBeNull();
  });
});

describe("the confirm dialog without a sequence step", () => {
  it("shows the wait text while the first transaction is prepared", async () => {
    const base = buildTestServices();
    const services: Partial<Services> = { chainAccess: { ...base.chainAccess, flowClient: (chainId) => ({ ...base.chainAccess.flowClient(chainId), estimateGas: () => new Promise(() => undefined) }) } };
    renderWithWallet(<TransactionDialog steps={await stepsOf()} onClose={() => undefined} />, { wallet: connectedWallet(), services });
    expect(await screen.findByText("Preparing the transaction: estimating gas and fees…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
  });
});
