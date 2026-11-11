import { StatefulBridgeForm } from "../support/stateful";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { PairConfig, TokenInfo } from "@terminal/model/types";
import { GAS_MODE_HELP } from "@zk-bridge/shared";
import type { WebStep } from "../../src/tx/bridge-steps";
import { buildFixtureContext } from "../helpers";
import { renderPage, type RenderPageOptions } from "../render";

const usdc = FIXTURE_TOKENS[0]!;
const weth = FIXTURE_TOKENS[2]!;

/** WETH on Ethereum arrives on PulseChain as the wrapped native token, which is worth one coin per token, so its price is known. */
const WRAPPED_TOKENS: readonly TokenInfo[] = [
  { ...weth, counterpart: FIXTURE_PAIR.second.contracts.wrappedNative },
  { address: FIXTURE_PAIR.second.contracts.wrappedNative!, symbol: "WPLS", decimals: 18, side: "second", counterpart: weth.address },
];

const renderForm = async (options: RenderPageOptions & { readonly tokens?: readonly TokenInfo[]; readonly variant?: "tokens" | "wrap"; readonly pair?: PairConfig; readonly onReview?: (steps: readonly WebStep[]) => void } = {}) => {
  const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
  const onReview = options.onReview ?? vi.fn();
  renderPage(<StatefulBridgeForm variant={options.variant ?? "tokens"} pair={options.pair ?? FIXTURE_PAIR} tokens={options.tokens ?? tokens} context={context} account={FIXTURE_ACCOUNT} onReview={onReview} />, options);
  return { onReview };
};

const typeAmount = (text: string) => userEvent.type(screen.getByLabelText(/^Amount to send/), text);

/** The fixture token has no valuation, so the default gas based tip needs the price of the sender. */
const typePrice = (text = "3000") => userEvent.type(screen.getByLabelText(/^Your coin price/), text);

const choosePercentage = () => userEvent.click(screen.getByRole("radio", { name: /Percentage of the amount/ }));

describe("the bridge form: the tip before any signature", () => {
  it("disables Review until the transaction can be built, and says why", async () => {
    await renderForm();
    const review = screen.getByRole("button", { name: "Review transaction" });
    expect(review).toBeDisabled();
    expect(review).toHaveAccessibleDescription("Enter an amount.");
    await typePrice();
    await typeAmount("99999999");
    expect(review).toBeDisabled();
    await waitFor(() => expect(review).toHaveAccessibleDescription(/more than your USDC balance/));
    await userEvent.clear(screen.getByLabelText(/^Amount to send/));
    await typeAmount("250");
    await waitFor(() => expect(review).toBeEnabled());
  });

  it("shows no bridge fee, because the mediator takes none", async () => {
    await renderForm();
    await typeAmount("250");
    await typePrice();
    await screen.findByTestId("delivery-quote");
    expect(screen.queryByTestId("bridge-fee")).toBeNull();
    expect(screen.queryByText(/Bridge fee/)).toBeNull();
  });

  it("turns the tip on by default as the gas based tip equal to the measured cost, and shows the limit as the price ceiling", async () => {
    await renderForm();
    await typeAmount("250");
    await typePrice();
    expect(screen.getByRole("radio", { name: /Gas based, up to the limit/ })).toBeChecked();
    expect(screen.getByLabelText("Gas multiplier")).toHaveValue("1");
    expect(screen.getByLabelText("Ceiling base fee (gwei)")).toHaveValue("");
    expect(screen.getByTestId("gas-mode-help")).toHaveTextContent(GAS_MODE_HELP);
    const quote = await screen.findByTestId("delivery-quote");
    await waitFor(() => expect(within(quote).getByTestId("delivery-summary")).toHaveTextContent(/^about [\d.]+ zUSDC now \(estimate, expected about [\d.]+ zUSDC, at most [\d.]+ zUSDC\)$/));
    expect(within(quote).getByTestId("tip-maximum")).toHaveTextContent(/^Expected tip about [\d.]+ zUSDC at the gas estimate\. The most it can take is [\d.]+ zUSDC, the limit: a deliverer who supplies more gas can raise the tip up to it\.$/);
    expect(screen.queryByTestId("tip-notice")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Review transaction" })).toBeEnabled());
  });

  it("asks for a price in the fee section as soon as the page is open, before any amount is typed, and offers no fixed fallback", async () => {
    await renderForm();
    expect(screen.getByTestId("tip-notice")).toHaveTextContent("Enter your price of the native coin in this token.");
    expect(screen.getByRole("radio", { name: /Percentage of the amount/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Fixed amount/ })).toBeEnabled();
    await typeAmount("250");
    expect(screen.getByRole("button", { name: "Review transaction" })).toHaveAccessibleDescription(/Enter your price of the native coin/);
    expect(screen.getAllByTestId("tip-notice")).toHaveLength(1);
    await typePrice();
    await waitFor(() => expect(screen.queryByTestId("tip-notice")).toBeNull());
  });

  it("explains that anyone can deliver, that the tip goes to the reward address, and that a direct delivery pays no tip", async () => {
    await renderForm();
    const notes = screen.getByTestId("tip-notes");
    expect(notes).toHaveTextContent("Anyone can deliver through the delivery router");
    expect(notes).toHaveTextContent(/pays the tip to its reward address.*copied delivery gains the copier nothing/);
    expect(notes).toHaveTextContent(/calls the bridge directly to deliver, without the router, no tip is paid. The recipient then gets the whole amount/);
  });

  it("shows the percentage, the cost lines and the data source once a coin price is known", async () => {
    await renderForm();
    await choosePercentage();
    await typeAmount("250");
    expect(await screen.findByTestId("no-cost-lines")).toHaveTextContent("Enter your coin price");
    await userEvent.type(screen.getByLabelText(/^Your coin price \(zUSDC for one PLS\)/), "3000");
    const quote = await screen.findByTestId("delivery-quote");
    const table = await within(quote).findByRole("table", { name: "Cost breakdown of the delivery" });
    for (const line of ["Gas cost", "Margin"]) expect(within(table).getByText(new RegExp(line))).toBeInTheDocument();
    expect(within(table).queryByText(/Proof cost/)).toBeNull();
    expect(within(table).getAllByText(/PLS on PulseChain$/).length).toBe(2);
    expect(screen.getByTestId("delivery-data-source")).toHaveTextContent("measured from 40 recent deliveries, p90");
    expect(screen.getByTestId("delivery-data-source")).toHaveTextContent(/base fee 7 gwei at block 21000000/);
  });

  it("says that the data is a default when no delivery is measured yet", async () => {
    await renderForm({ report: { sampleCount: 0 } });
    await typeAmount("250");
    await typePrice();
    expect(await screen.findByTestId("delivery-data-source")).toHaveTextContent("default, no deliveries measured yet");
  });

  it("the fee section shows the range as low, suggested and high, editable", async () => {
    await renderForm();
    await typeAmount("250");
    await typePrice();
    const range = await screen.findByTestId("tip-range");
    const low = within(range).getByTestId("tip-range-low");
    const suggested = within(range).getByTestId("tip-range-default");
    const high = within(range).getByTestId("tip-range-high");
    expect(low).toHaveTextContent(/^Low: /);
    expect(suggested).toHaveTextContent(/^Suggested: /);
    expect(high).toHaveTextContent(/^High: /);
    expect(suggested).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(low);
    expect(screen.getByLabelText("Gas multiplier")).toHaveValue("0.5");
    expect(low).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(high);
    expect(screen.getByLabelText("Gas multiplier")).toHaveValue("1.5");
    // The user can type any multiplier by hand, below the cost included.
    await userEvent.clear(screen.getByLabelText("Gas multiplier"));
    await userEvent.type(screen.getByLabelText("Gas multiplier"), "0.1");
    expect(screen.getByLabelText("Gas multiplier")).toHaveValue("0.1");
    expect(range).toHaveTextContent(/lowest tip is just above zero/i);
  });

  it("says in the fee section that a tip is voluntary and buys no promise, and never names proving", async () => {
    await renderForm();
    await typeAmount("250");
    await typePrice();
    const section = await screen.findByTestId("delivery-quote");
    const fieldset = section.closest("fieldset");
    expect(fieldset).toHaveTextContent(/voluntary and it buys no promise/);
    expect(fieldset?.textContent ?? "").not.toMatch(/proof|prover|proving/i);
  });

  it("edits the percentage, and the tip follows", async () => {
    await renderForm();
    await choosePercentage();
    await typeAmount("250");
    const percentage = screen.getByLabelText("Percentage of the amount");
    await userEvent.clear(percentage);
    await userEvent.type(percentage, "0.5");
    await waitFor(() => expect(screen.getByTestId("delivery-summary")).toHaveTextContent("1.25 zUSDC (exact)"));
  });

  it("labels the price field as the user's own, and fills it from the valuation of a wrapped native token", async () => {
    await renderForm({ tokens: WRAPPED_TOKENS });
    await userEvent.selectOptions(screen.getByLabelText("Token"), `first:${weth.address}`);
    const price = screen.getByLabelText(/^Your coin price \(WPLS for one PLS\)/);
    expect(price).toHaveValue("1");
    expect(screen.getByText(/Your own price\. The page cannot verify it/)).toBeInTheDocument();
  });

  it("offers the gas multiplier for any token, asks for a price, and labels it an estimate with a maximum", async () => {
    await renderForm();
    await typeAmount("250");
    const radio = screen.getByRole("radio", { name: /Gas based, up to the limit/ });
    expect(radio).toBeEnabled();
    expect(screen.queryByText(/only for the wrapped native/)).toBeNull();
    await userEvent.click(radio);
    expect((await screen.findAllByText(/Enter your price of the native coin/)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Review transaction" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/^Your coin price/), "3000");
    const summary = await screen.findByTestId("delivery-summary");
    await waitFor(() => expect(summary).toHaveTextContent(/estimate, expected about [\d.]+ zUSDC, at most [\d.]+ zUSDC\)$/));
    expect(screen.getByText(/This is an estimate: the real tip follows the gas that the delivery uses/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review transaction" })).toBeEnabled();
  });

  it("labels a gas multiplier tip an estimate for the wrapped native token with no price typed", async () => {
    await renderForm({ tokens: WRAPPED_TOKENS });
    await userEvent.selectOptions(screen.getByLabelText("Token"), `first:${weth.address}`);
    await typeAmount("2");
    await userEvent.click(screen.getByRole("radio", { name: /Gas based, up to the limit/ }));
    const summary = await screen.findByTestId("delivery-summary");
    await waitFor(() => expect(summary).toHaveTextContent(/estimate, expected about [\d.]+ WPLS, at most [\d.]+ WPLS\)$/));
    expect(summary).toHaveTextContent(/^about [\d.]+ WPLS now/);
    expect(screen.getByTestId("tip-maximum")).toHaveTextContent(/The most it can take is [\d.]+ WPLS/);
  });

  it("raises the maximum when the user raises the ceiling", async () => {
    await renderForm({ tokens: WRAPPED_TOKENS });
    await userEvent.selectOptions(screen.getByLabelText("Token"), `first:${weth.address}`);
    await typeAmount("2");
    await userEvent.click(screen.getByRole("radio", { name: /Gas based, up to the limit/ }));
    const before = (await screen.findByTestId("tip-maximum")).textContent;
    await userEvent.type(screen.getByLabelText("Ceiling base fee (gwei)"), "500");
    await waitFor(() => expect(screen.getByTestId("tip-maximum").textContent).not.toBe(before));
  });

  it("shows the router of the deployment as the default of the advanced field, with no warning", async () => {
    await renderForm();
    const router = screen.getByLabelText("Router on PulseChain");
    expect(router).toHaveValue(getAddress(FIXTURE_PAIR.second.contracts.deliveryRouter!));
    expect(screen.queryByTestId("tip-router-warning")).toBeNull();
  });

  it("marks a router that is not the one of the deployment, and sends the relay to it", async () => {
    const { onReview } = await renderForm();
    await typeAmount("250");
    await typePrice();
    const other = getAddress(`0x${"ee".repeat(20)}`);
    const router = screen.getByLabelText("Router on PulseChain");
    await userEvent.clear(router);
    await userEvent.type(router, other);
    expect(await screen.findByTestId("tip-router-warning")).toHaveTextContent("is not the default delivery router");
    const review = screen.getByRole("button", { name: "Review transaction" });
    await waitFor(() => expect(review).toBeEnabled());
    await userEvent.click(review);
    const steps = (onReview as ReturnType<typeof vi.fn>).mock.calls[0]![0] as readonly WebStep[];
    expect(steps.at(-1)!.disclosure.delivery?.router).toBe(other);
  });

  it("removes the tip with No tip: a plain relay, the receiver mode returns, and the page says what that means", async () => {
    const { onReview } = await renderForm();
    await typeAmount("250");
    await typePrice();
    await screen.findByTestId("delivery-quote");
    expect(screen.queryByLabelText("How the receiver gets it")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: /No tip: deliver directly, no router/ }));
    expect(screen.queryByTestId("delivery-quote")).toBeNull();
    expect(screen.getByTestId("no-tip-note")).toHaveTextContent(/No router and no fee terms are involved.*Anyone can deliver your transfer directly on the bridge, for free.*may take longer/);
    expect(screen.getByLabelText("How the receiver gets it")).toBeInTheDocument();
    const review = screen.getByRole("button", { name: "Review transaction" });
    await waitFor(() => expect(review).toBeEnabled());
    await userEvent.click(review);
    const steps = (onReview as ReturnType<typeof vi.fn>).mock.calls[0]![0] as readonly WebStep[];
    expect(steps.at(-1)!.disclosure.delivery).toBeNull();
    expect(steps.at(-1)!.plan.functionName).toBe("relayTokens");
  });

  it("sends a plain relay toward a chain with no delivery router, and says so", async () => {
    await renderForm({ pair: { ...FIXTURE_PAIR, first: { ...FIXTURE_PAIR.first, contracts: { ...FIXTURE_PAIR.first.contracts, deliveryRouter: null } } } });
    await userEvent.selectOptions(screen.getByLabelText("Token"), `second:${FIXTURE_TOKENS[4]!.address}`);
    expect(screen.getByText(/no delivery router for Ethereum.*plain relay, with no tip/)).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /No tip/ })).toBeNull();
    expect(screen.getByLabelText("How the receiver gets it")).toBeInTheDocument();
  });

  it("hands the planned steps to the review, and the last one carries the tip", async () => {
    const { onReview } = await renderForm();
    await typeAmount("250");
    await typePrice();
    await screen.findByTestId("delivery-quote");
    const review = screen.getByRole("button", { name: "Review transaction" });
    await waitFor(() => expect(review).toBeEnabled());
    await userEvent.click(review);
    expect(onReview).toHaveBeenCalledTimes(1);
    const steps = (onReview as ReturnType<typeof vi.fn>).mock.calls[0]![0] as readonly WebStep[];
    expect(steps.at(-1)!.disclosure.delivery).not.toBeNull();
    expect(steps.at(-1)!.plan.functionName).toBe("relayTokensAndCall");
  });

  it("tips the native coin by default through the router's relayTokensAndCall, paid in the copy, with no pay-out in the native coin", async () => {
    const { onReview } = await renderForm({ variant: "wrap" });
    await typeAmount("1");
    expect(screen.getByRole("radio", { name: /Gas based, up to the limit/ })).toBeChecked();
    await choosePercentage();
    await screen.findByTestId("delivery-quote");
    expect(screen.queryByLabelText(/^Pay out in/)).toBeNull();
    const review = screen.getByRole("button", { name: "Review transaction" });
    await waitFor(() => expect(review).toBeEnabled());
    await userEvent.click(review);
    const steps = (onReview as ReturnType<typeof vi.fn>).mock.calls[0]![0] as readonly WebStep[];
    expect(steps).toHaveLength(1);
    expect(steps[0]!.plan).toMatchObject({ functionName: "relayTokensAndCall", functionSignature: "relayTokensAndCall(address,bytes,uint256,bytes)", to: FIXTURE_PAIR.first.contracts.deliveryRouter });
    expect(steps[0]!.disclosure.delivery?.token.symbol).toBe("zETH");
  });

  it("sends a plain wrap when the user chooses No tip, and says what that means", async () => {
    const { onReview } = await renderForm({ variant: "wrap" });
    await typeAmount("1");
    await userEvent.click(screen.getByRole("radio", { name: /^No tip/ }));
    expect(screen.getByTestId("no-tip-note")).toHaveTextContent(/^No tip\. The delivery router wraps the coin you send.*Anyone can deliver it on the other chain, for free\. It may take longer/);
    const review = screen.getByRole("button", { name: "Review transaction" });
    await waitFor(() => expect(review).toBeEnabled());
    await userEvent.click(review);
    const steps = (onReview as ReturnType<typeof vi.fn>).mock.calls[0]![0] as readonly WebStep[];
    expect(steps).toHaveLength(1);
    expect(steps[0]!.plan.functionName).toBe("wrapAndRelayTokens");
    expect(steps[0]!.disclosure.delivery).toBeNull();
  });

  it("lists only the native coin of each chain in the wrap variant", async () => {
    await renderForm({ variant: "wrap" });
    const options = within(screen.getByLabelText("Coin to wrap")).getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual([expect.stringMatching(/^Wrap ETH on Ethereum/), expect.stringMatching(/^Wrap PLS on PulseChain/)]);
    await typeAmount("1");
    await choosePercentage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Review transaction" })).toBeEnabled());
    expect(screen.queryByTestId("bridge-fee")).toBeNull();
  });
});
