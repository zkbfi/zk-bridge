import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { PairConfig, TokenInfo } from "@terminal/model/types";
import { BridgeForm, type BridgeFormProps } from "../../src/actions/BridgeForm";
import type { WebStep } from "../../src/tx/bridge-steps";
import { buildFixtureContext } from "../helpers";
import { renderPage, type RenderPageOptions } from "../render";
import { connectedWallet, walletWrapper } from "../app/support";

const usdc = FIXTURE_TOKENS[0]!;
const weth = FIXTURE_TOKENS[2]!;

/** WETH on Ethereum arrives on PulseChain as the wrapped native token, so the page knows its price and offers the payout choice. */
const WRAPPED_TOKENS: readonly TokenInfo[] = [
  { ...weth, counterpart: FIXTURE_PAIR.second.contracts.wrappedNative },
  { address: FIXTURE_PAIR.second.contracts.wrappedNative!, symbol: "WPLS", decimals: 18, side: "second", counterpart: weth.address },
];

type FormOverrides = Partial<Pick<BridgeFormProps, "variant" | "pair" | "tokens" | "context">>;

const renderForm = async (overrides: FormOverrides = {}, options: RenderPageOptions = {}) => {
  const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
  const onReview = vi.fn();
  renderPage(
    <BridgeForm variant={overrides.variant ?? "tokens"} pair={overrides.pair ?? FIXTURE_PAIR} tokens={overrides.tokens ?? tokens} context={overrides.context ?? context} account={FIXTURE_ACCOUNT} onReview={onReview} />,
    options,
  );
  return { onReview, context, tokens };
};

const optionTexts = (label: string): (string | null)[] => within(screen.getByLabelText(label)).getAllByRole("option").map((option) => option.textContent);

describe("the tip fields of each mode", () => {
  it("edits the fixed amount and the margin, which the fixed mode shows instead of the percentage", async () => {
    await renderForm();
    await userEvent.type(screen.getByLabelText(/^Amount to send/), "250");
    await userEvent.click(screen.getByRole("radio", { name: /Fixed amount/ }));
    expect(screen.queryByLabelText("Percentage of the amount")).toBeNull();
    const fixed = screen.getByLabelText("Fixed amount");
    const margin = screen.getByLabelText("Margin (percent)");
    await userEvent.type(fixed, "0.5");
    await userEvent.clear(margin);
    await userEvent.type(margin, "25");
    expect(fixed).toHaveValue("0.5");
    expect(margin).toHaveValue("25");
    await waitFor(() => expect(screen.getByTestId("delivery-summary")).toHaveTextContent("0.5 zkbUSDC (exact)"));
  });

  it("edits the gas multiplier", async () => {
    await renderForm();
    await userEvent.type(screen.getByLabelText(/^Amount to send/), "250");
    await userEvent.click(screen.getByRole("radio", { name: /Gas based, up to the limit/ }));
    const multiplier = screen.getByLabelText("Gas multiplier");
    expect(multiplier).toHaveValue("2");
    await userEvent.clear(multiplier);
    await userEvent.type(multiplier, "1.5");
    expect(multiplier).toHaveValue("1.5");
  });

  it("edits the price of the coin, and the field keeps what the user typed", async () => {
    await renderForm();
    await userEvent.type(screen.getByLabelText(/^Amount to send/), "250");
    const price = screen.getByLabelText(/^Your coin price/);
    await userEvent.type(price, "3000");
    expect(price).toHaveValue("3000");
  });

  it("offers the payout in the native coin for a wrapped native token, and keeps the choice", async () => {
    await renderForm({ tokens: WRAPPED_TOKENS });
    await userEvent.selectOptions(screen.getByLabelText("Token"), `first:${weth.address}`);
    const payout = screen.getByLabelText("Pay out in PLS, not in the wrapped token");
    expect(payout).not.toBeChecked();
    await userEvent.click(payout);
    expect(payout).toBeChecked();
  });

  it("offers no payout choice for a token that is not the wrapped native token", async () => {
    await renderForm();
    expect(screen.queryByLabelText(/Pay out in/)).toBeNull();
  });

  it("opens the advanced router field when the user typed a router, and resets the price and the router when the token changes", async () => {
    await renderForm({ tokens: WRAPPED_TOKENS });
    await userEvent.selectOptions(screen.getByLabelText("Token"), `first:${weth.address}`);
    const advanced = screen.getByTestId("tip-advanced");
    expect(advanced).not.toHaveAttribute("open");
    const router = screen.getByLabelText("Router on PulseChain");
    const other = getAddress(`0x${"ee".repeat(20)}`);
    await userEvent.clear(router);
    await userEvent.type(router, other);
    await userEvent.type(screen.getByLabelText(/^Your coin price/), "2");
    expect(screen.getByTestId("tip-advanced")).toHaveAttribute("open");
    await userEvent.selectOptions(screen.getByLabelText("Token"), `second:${FIXTURE_PAIR.second.contracts.wrappedNative}`);
    await userEvent.selectOptions(screen.getByLabelText("Token"), `first:${weth.address}`);
    expect(screen.getByLabelText("Router on PulseChain")).toHaveValue(getAddress(FIXTURE_PAIR.second.contracts.deliveryRouter!));
    expect(screen.getByLabelText(/^Your coin price/)).toHaveValue("1");
  });
});

describe("the receiver modes without a tip", () => {
  const chooseNoTip = async () => {
    await userEvent.click(screen.getByRole("radio", { name: /No tip: deliver directly, no router/ }));
  };

  it("shows the data field for a transfer and call, and sends relayTokensAndCall with that data", async () => {
    const { onReview } = await renderForm();
    await userEvent.type(screen.getByLabelText(/^Amount to send/), "250");
    await chooseNoTip();
    expect(screen.queryByLabelText("Data for the receiver")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("How the receiver gets it"), "call");
    const data = screen.getByLabelText("Data for the receiver");
    await userEvent.type(data, "0xabcd");
    expect(data).toHaveValue("0xabcd");
    expect(screen.queryByLabelText("Fallback recipient")).toBeNull();
    expect(screen.queryByRole("option", { name: /fallback/i })).toBeNull();
    const review = screen.getByRole("button", { name: "Review transaction" });
    await waitFor(() => expect(review).toBeEnabled());
    await userEvent.click(review);
    const steps = onReview.mock.calls[0]![0] as readonly WebStep[];
    expect(steps.at(-1)!.plan.functionName).toBe("relayTokensAndCall");
  });

  it("offers only a plain transfer and a transfer with a call", async () => {
    await renderForm();
    await chooseNoTip();
    const options = within(screen.getByLabelText("How the receiver gets it")).getAllByRole("option").map((option) => option.getAttribute("value"));
    expect(options).toEqual(["plain", "call"]);
  });

  it("sends the plain function when the gas limit is empty", async () => {
    const { onReview } = await renderForm();
    await userEvent.type(screen.getByLabelText(/^Amount to send/), "250");
    await chooseNoTip();
    expect(screen.getByLabelText("Gas limit")).toHaveValue("");
    const review = screen.getByRole("button", { name: "Review transaction" });
    await waitFor(() => expect(review).toBeEnabled());
    await userEvent.click(review);
    const steps = onReview.mock.calls[0]![0] as readonly WebStep[];
    expect(steps.at(-1)!.plan.functionSignature).toBe("relayTokens(address,address,uint256)");
  });

  it("sends the gas limit overload of relayTokens when a gas limit is typed", async () => {
    const { onReview } = await renderForm();
    await userEvent.type(screen.getByLabelText(/^Amount to send/), "250");
    await chooseNoTip();
    await userEvent.type(screen.getByLabelText("Gas limit"), "900000");
    const review = screen.getByRole("button", { name: "Review transaction" });
    await waitFor(() => expect(review).toBeEnabled());
    await userEvent.click(review);
    const steps = onReview.mock.calls[0]![0] as readonly WebStep[];
    expect(steps.at(-1)!.plan.functionSignature).toBe("relayTokens(address,address,uint256,uint256)");
  });

  it("sends the gas limit overload of relayTokensAndCall for a transfer with a call", async () => {
    const { onReview } = await renderForm();
    await userEvent.type(screen.getByLabelText(/^Amount to send/), "250");
    await chooseNoTip();
    await userEvent.selectOptions(screen.getByLabelText("How the receiver gets it"), "call");
    await userEvent.type(screen.getByLabelText("Data for the receiver"), "0xabcd");
    await userEvent.type(screen.getByLabelText("Gas limit"), "900000");
    const review = screen.getByRole("button", { name: "Review transaction" });
    await waitFor(() => expect(review).toBeEnabled());
    await userEvent.click(review);
    const steps = onReview.mock.calls[0]![0] as readonly WebStep[];
    expect(steps.at(-1)!.plan.functionSignature).toBe("relayTokensAndCall(address,address,uint256,bytes,uint256)");
  });

  it("blocks the review and says why when the gas limit is not a whole number", async () => {
    await renderForm();
    await userEvent.type(screen.getByLabelText(/^Amount to send/), "250");
    await chooseNoTip();
    await userEvent.type(screen.getByLabelText("Gas limit"), "abc");
    await waitFor(() => expect(screen.getByText(/gas limit must be a whole number above zero/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Review transaction" })).toBeDisabled();
  });

  it("hides the gas limit on the wrap form, which has no such overload", async () => {
    await renderForm({ variant: "wrap" });
    expect(screen.queryByLabelText("Gas limit")).toBeNull();
  });
});

describe("the receiver field", () => {
  it("starts with the account and takes another address", async () => {
    await renderForm();
    const receiver = screen.getByLabelText(/^Receiver on PulseChain/);
    expect(receiver).toHaveValue(FIXTURE_ACCOUNT);
    await userEvent.clear(receiver);
    await userEvent.type(receiver, "0x12");
    expect(receiver).toHaveValue("0x12");
  });
});

describe("the review button", () => {
  it("sends nothing to the review when the form is submitted before the draft is ready", async () => {
    const { onReview } = await renderForm();
    fireEvent.submit(screen.getByRole("form", { name: "Bridge tokens" }));
    expect(onReview).not.toHaveBeenCalled();
  });
});

describe("the delivery cost that does not load", () => {
  it("says so while the tip is on, and says nothing once the user removes the tip", async () => {
    await renderForm({}, { reportOverride: () => { throw new Error("the indexer is down"); } });
    expect(await screen.findByText("The delivery cost did not load: the indexer is down")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /No tip: deliver directly, no router/ }));
    expect(screen.queryByText(/The delivery cost did not load/)).toBeNull();
  });
});

describe("the labels of the token choices", () => {
  it("shows the balance of the account when the live state has it", async () => {
    await renderForm();
    expect(optionTexts("Token")[0]).toMatch(/^USDC on Ethereum, you hold /);
  });

  it("shows no balance when the live state has no snapshots", async () => {
    const { context } = await buildFixtureContext();
    await renderForm({ context: { ...context, snapshots: null } });
    for (const text of optionTexts("Token")) expect(text).not.toContain("you hold");
  });

  it("shows no balance for a chain whose snapshot failed, and still shows the other chain", async () => {
    const { context } = await buildFixtureContext();
    const snapshots = (context.snapshots ?? []).map((result) => (result.status === "ok" && result.snapshot.chain.side === "first" ? { status: "error" as const, chain: result.snapshot.chain, message: "no endpoint" } : result));
    await renderForm({ context: { ...context, snapshots } });
    const texts = optionTexts("Token");
    expect(texts.find((text) => text?.startsWith("USDC on Ethereum"))).toBe("USDC on Ethereum");
    expect(texts.find((text) => text?.startsWith("zkbUSDC on PulseChain"))).toMatch(/you hold /);
  });

  it("shows no coin balance in the wrap variant for a chain whose snapshot failed", async () => {
    const { context } = await buildFixtureContext();
    const snapshots = (context.snapshots ?? []).map((result) => (result.status === "ok" && result.snapshot.chain.side === "second" ? { status: "error" as const, chain: result.snapshot.chain, message: "no endpoint" } : result));
    await renderForm({ variant: "wrap", context: { ...context, snapshots } });
    const texts = optionTexts("Coin to wrap");
    expect(texts[0]).toMatch(/^Wrap ETH on Ethereum, you hold /);
    expect(texts[1]).toBe("Wrap PLS on PulseChain");
  });

  it("offers only the chain that has a delivery router in the wrap variant", async () => {
    const pair: PairConfig = { ...FIXTURE_PAIR, first: { ...FIXTURE_PAIR.first, contracts: { ...FIXTURE_PAIR.first.contracts, deliveryRouter: null } } };
    await renderForm({ variant: "wrap", pair });
    expect(optionTexts("Coin to wrap")).toEqual([expect.stringMatching(/^Wrap PLS on PulseChain/)]);
  });
});

describe("a change of the token list under the form", () => {
  const rerenderWith = async () => {
    const { context } = await buildFixtureContext({ allowance: 10n ** 12n });
    const Wrapper = walletWrapper({ wallet: connectedWallet() });
    const form = (tokens: readonly TokenInfo[]) => <BridgeForm variant="tokens" pair={FIXTURE_PAIR} tokens={tokens} context={context} account={FIXTURE_ACCOUNT} onReview={() => undefined} />;
    const result = render(form([usdc, weth]), { wrapper: Wrapper });
    return { form, ...result };
  };

  it("falls back to the first choice when the chosen token leaves the list, and shows no tip panel without a token", async () => {
    const { form, rerender } = await rerenderWith();
    await userEvent.selectOptions(screen.getByLabelText("Token"), `first:${weth.address}`);
    expect(screen.getByLabelText("Token")).toHaveValue(`first:${weth.address}`);
    rerender(form([usdc]));
    expect(screen.getByLabelText("Token")).toHaveValue(`first:${usdc.address}`);
    rerender(form([]));
    expect(within(screen.getByLabelText("Token")).queryAllByRole("option")).toHaveLength(0);
    expect(screen.queryByText("Tip for delivery")).toBeNull();
    expect(screen.getByRole("button", { name: "Review transaction" })).toBeDisabled();
  });

  it("starts with no choice when the list is empty", async () => {
    const { context } = await buildFixtureContext();
    render(<BridgeForm variant="tokens" pair={FIXTURE_PAIR} tokens={[]} context={context} account={FIXTURE_ACCOUNT} onReview={() => undefined} />, { wrapper: walletWrapper({ wallet: connectedWallet() }) });
    expect(within(screen.getByLabelText("Token")).queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Review transaction" })).toBeDisabled();
  });
});

describe("the call fields", () => {
  it("renders both fields empty and shows no complaint", async () => {
    await renderForm();
    expect(screen.getByLabelText("Call target")).toHaveValue("");
    expect(screen.getByLabelText("Call data")).toHaveValue("");
    expect(screen.queryByText(/needs a call target/)).toBeNull();
  });

  it("says why when call data has no target, and keeps the review disabled", async () => {
    await renderForm();
    await userEvent.type(screen.getByLabelText(/^Amount to send/), "250");
    await userEvent.click(screen.getByRole("radio", { name: /No tip: deliver directly, no router/ }));
    await userEvent.type(screen.getByLabelText("Call data"), "0xabcd");
    expect(await screen.findByText("The call data needs a call target. Enter the target contract, or clear the call data.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review transaction" })).toBeDisabled();
  });

  it("says that a call needs a tip when the user chose no tip", async () => {
    await renderForm();
    await userEvent.type(screen.getByLabelText(/^Amount to send/), "250");
    await userEvent.click(screen.getByRole("radio", { name: /No tip: deliver directly, no router/ }));
    await userEvent.type(screen.getByLabelText("Call target"), `0x${"77".repeat(20)}`);
    expect(await screen.findByText(/A call after the delivery needs a tip/)).toBeVisible();
  });

  it("offers no call fields on the wrap form", async () => {
    await renderForm({ variant: "wrap" });
    expect(screen.queryByLabelText("Call target")).toBeNull();
  });
});
