import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { deliverySummary } from "../../src/bridge/DeliveryMenu";
import { connectedWallet, renderWithWallet } from "../app/support";

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?bridge.amount=0.01`);
});

const FACTS = { destination: "PulseChain", feeShareText: "0.39%", worstCaseText: "$0.60", fixedText: "0.50 USDC", feeAmountText: "$0.39", worstCaseShareText: "0.6%" };

describe("deliverySummary (owner, quote 88: \"just tell the user what is happening\")", () => {
  it("states the arrangement in plain words for each mode, never a label like Standard delivery", () => {
    expect(deliverySummary({}, FACTS).text).toBe("Deliver for 0.39%, max $0.39");
    expect(deliverySummary({ tip: { mode: "percentage", percentText: "0.3" } }, FACTS).text).toBe("Deliver for 0.39%, max $0.39");
    expect(deliverySummary({ tip: { mode: "gas-multiplier" } }, FACTS).text).toBe("Deliver for ~0.39%, max $0.60 (0.6%)");
    expect(deliverySummary({ tip: { mode: "fixed" } }, FACTS).text).toBe("Deliver for 0.50 USDC (0.39%)");
    expect(deliverySummary({ tip: { mode: "none" } }, FACTS).text).toBe("You deliver it yourself on PulseChain");
    expect(deliverySummary({}, { ...FACTS, feeShareText: null, feeAmountText: null }).text).toBe("Deliver for a share of the amount");
    for (const mode of ["percentage", "fixed", "gas-multiplier", "none"] as const) expect(deliverySummary({ tip: { mode } }, FACTS).full).not.toMatch(/Standard|Fast/);
  });

  it("names a call, a custom router and a gas limit, short in the pill and whole in the label", () => {
    const target = "0x1234567890abcdef1234567890abcdef123456ab";
    const router = "0xabcdef1234567890abcdef1234567890abcdef12";
    const summary = deliverySummary({ mode: "call", callTarget: target, gasLimit: "300000", tip: { routerText: router } }, FACTS);
    expect(summary.text).toBe("Deliver for 0.39%, max $0.39, then calls 0x12…ab · via router 0xab…12 · gas limit 300,000");
    expect(summary.full).toBe(`Deliver for 0.39%, max $0.39, then calls ${target} · via router ${router} · gas limit 300,000`);
  });
});

describe("deliverySummary's short text is hard numbers, never a placeholder or a reason", () => {
  const level = { gasLevelName: "Normal", percentText: "1%" };
  const short = (form: Parameters<typeof deliverySummary>[0], facts: Partial<Parameters<typeof deliverySummary>[1]>) => deliverySummary(form, { ...FACTS, ...facts }).short;
  it("percentage mode shows the percent from the form before an amount is known, the max once it is", () => {
    expect(short({}, { ...level, feeShareText: null, feeAmountText: null })).toBe("Deliver for 1%");
    expect(short({}, level)).toBe("Deliver for 0.39%, max $0.39");
  });
  it("fixed mode shows the amount and symbol", () => {
    expect(short({ tip: { mode: "fixed" } }, level)).toBe("Deliver for 0.50 USDC (0.39%)");
    // Fixed mode does not use the gas level: with no amount yet, the text names the next action.
    expect(short({ tip: { mode: "fixed" } }, { ...level, fixedText: null })).toBe("Set the fixed fee");
  });
  it("gas mode shows the numbers when known, else the gas level name", () => {
    expect(short({ tip: { mode: "gas-multiplier" } }, level)).toBe("Deliver for ~0.39%, max $0.60 (0.6%)");
    expect(short({}, { ...level, feeShareText: null, feeAmountText: null, percentText: null })).toBe("Set the share");
    expect(short({ tip: { mode: "gas-multiplier" } }, { ...level, feeShareText: null, worstCaseText: null })).toBe("Deliver at Normal gas");
    expect(short({ tip: { mode: "gas-multiplier" } }, { ...level, feeShareText: null })).toBe("Deliver at Normal gas, max $0.60 (0.6%)");
  });
  it("none mode is short", () => {
    expect(short({ tip: { mode: "none" } }, level)).toBe("You deliver it");
  });
  it("never uses a placeholder phrase", () => {
    for (const mode of ["percentage", "fixed", "gas-multiplier"] as const)
      expect(short({ tip: { mode } }, { ...level, feeShareText: null, feeAmountText: null, fixedText: null, worstCaseText: null })).not.toMatch(/a share|a fixed fee|the gas cost|Deliver for gas/);
  });
});

const menuOpen = async (query = "bridge.amount=500") => {
  window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?${query}`);
  renderWithWallet(<Shell />, { wallet: connectedWallet() });
  await waitFor(() => expect(document.querySelector('[data-fee="tip"]')?.getAttribute("aria-label")).toMatch(/Fee \d/), { timeout: 3000 });
  await userEvent.click(screen.getByRole("button", { name: /^Delivery settings/ }));
  return screen.getByRole("group", { name: "Delivery settings" });
};
const feeText = (): string => document.querySelector('[data-fee="tip"]')?.textContent ?? "";
const pillLabel = (): string => screen.getByRole("button", { name: /^Delivery settings/ }).getAttribute("aria-label") ?? "";
const typeExact = async (scope: HTMLElement, label: string, text: string) => {
  const field = within(scope).getByRole("textbox", { name: `${label}, exact` });
  await userEvent.clear(field);
  await userEvent.type(field, text);
};

describe("the delivery settings menu", () => {
  it("offers every tip mode with its value, the gas level and the gas limit, and no speed presets", async () => {
    const menu = await menuOpen();
    expect(within(menu).getByRole("radiogroup", { name: "Who delivers" })).toBeInTheDocument();
    expect(within(menu).queryByRole("radio", { name: /Standard|Fast/ })).toBeNull();
    expect(within(menu).getByRole("radio", { name: "Automatic" })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("slider", { name: "Tip" })).toBeInTheDocument();
    expect(within(menu).getByRole("slider", { name: "Gas level" })).toBeInTheDocument();
    expect(within(menu).queryByRole("slider", { name: "Gas limit" })).toBeNull();
    await userEvent.click(within(menu).getByRole("button", { name: "Advanced" }));
    expect(within(menu).getByRole("slider", { name: "Gas limit" })).toBeInTheDocument();
    expect(within(menu).getByRole("textbox", { name: /Relay router/ })).toBeInTheDocument();
    expect(within(menu).getByRole("textbox", { name: /Call after delivery/ })).toBeInTheDocument();
    expect(pillLabel()).toMatch(/^Delivery settings: Deliver for [\d.]+%, max .+\. Fee /);
    expect(document.querySelector('[data-fee="tip"]')?.textContent).toMatch(/^Deliver for [\d.]+%, max .+$/);
  });

  it("drives the fee from the share typed in the menu, and the drawer's tip slider shows the same value", async () => {
    const menu = await menuOpen();
    const before = feeText();
    await typeExact(menu, "Tip", "1");
    await waitFor(() => expect(window.location.hash).toMatch(/tip\.percent=1\.0/));
    expect(feeText()).not.toBe(before);
    expect(within(menu).getByRole("radio", { name: "Share" })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("slider", { name: "Tip" })).toHaveValue("1");
    // Reset to recommended hands the fee back to the automatic rule.
    await userEvent.click(within(menu).getByRole("button", { name: "Reset to recommended" }));
    await waitFor(() => expect(feeText()).toBe(before));
    expect(window.location.hash).not.toMatch(/tip\.percent/);
  });

  it("refuses a share that is not a number with an inline message and writes nothing", async () => {
    const menu = await menuOpen();
    await typeExact(menu, "Tip", "abc");
    expect(within(menu).getByRole("alert")).toHaveTextContent(/Enter a number/);
    expect(window.location.hash).not.toMatch(/tip\.percent/);
  });

  it("drives the fee from a fixed amount in the token, and says so in the pill", async () => {
    const menu = await menuOpen();
    await userEvent.click(within(menu).getByRole("radio", { name: "Fixed" }));
    await waitFor(() => expect(window.location.hash).toMatch(/tip\.mode=fixed/));
    expect(within(menu).getByRole("slider", { name: "Fixed fee" })).toBeInTheDocument();
    await typeExact(menu, "Fixed fee", "2.5");
    await waitFor(() => expect(window.location.hash).toMatch(/tip\.fixed=2\.5/));
    await waitFor(() => expect(feeText()).toMatch(/2\.5/));
    expect(pillLabel()).toMatch(/Deliver for 2\.5 /);
    await typeExact(menu, "Fixed fee", "1.1234567890123456789");
    expect(within(menu).getByRole("alert")).toHaveTextContent(/at most \d+ decimals/);
  });

  it("drives a gas-based fee from its factor on the gas cost", async () => {
    const menu = await menuOpen("dir=second-to-first&bridge.amount=1000&tip.price=3000");
    await userEvent.click(within(menu).getByRole("radio", { name: "Gas-based" }));
    await waitFor(() => expect(within(menu).getByRole("slider", { name: "Fee on gas" })).toBeInTheDocument());
    await typeExact(menu, "Fee on gas", "1");
    await waitFor(() => expect(window.location.hash).toMatch(/tip\.gas=1(&|$)/));
    const once = pillLabel();
    await typeExact(menu, "Fee on gas", "1.5");
    await waitFor(() => expect(window.location.hash).toMatch(/tip\.gas=1\.5/));
    await waitFor(() => expect(pillLabel()).not.toBe(once));
    expect(feeText()).toMatch(/^Deliver for (~[\d.]+%|gas)/);
    expect(pillLabel()).toMatch(/Deliver for (~[\d.]+%|the gas cost), max \$/);
  });

  it("says you deliver it yourself with no tip", async () => {
    const menu = await menuOpen();
    await userEvent.click(within(menu).getByRole("radio", { name: "Yourself" }));
    await waitFor(() => expect(pillLabel()).toMatch(/^Delivery settings: You deliver it yourself on /));
    expect(feeText()).toBe("You deliver it");
  });

  it("sets the gas level from the menu as an anchor with a 15-minute range, and resets it", async () => {
    const menu = await menuOpen();
    expect(within(menu).getByText(/^Anchored at today's gas · could land (?:between \$[\d.]+ and \$[\d.]+|about \$[\d.]+) over 15 min \(gas [\d.,]+–[\d.,]+ \w+\)$/)).toBeInTheDocument();
    const bars = screen.getByRole("button", { name: /^Gas level: / });
    await userEvent.click(bars);
    await waitFor(() => expect(screen.getByRole("button", { name: "Gas level: High. Change" })).toBeInTheDocument());
    await userEvent.click(within(menu).getAllByRole("button", { name: "Reset to recommended" })[0]!);
    await waitFor(() => expect(window.location.hash).not.toMatch(/tip\.ceiling=/));
  });

  it("takes a gas limit typed against the recommendation, and resets to it", async () => {
    const menu = await menuOpen();
    await userEvent.click(within(menu).getByRole("button", { name: "Advanced" }));
    await typeExact(menu, "Gas limit", "400000");
    await waitFor(() => expect(window.location.hash).toMatch(/bridge\.gas=400000|gasLimit=400000|\.gas=400000/));
    expect(pillLabel()).toMatch(/gas limit 400,000/);
    const resets = within(menu).getAllByRole("button", { name: "Reset to recommended" });
    await userEvent.click(resets[resets.length - 1]!);
    await waitFor(() => expect(pillLabel()).not.toMatch(/gas limit/));
  });
});

describe("the gas level on the gas can", () => {
  it("is the bars beside the can: each tap moves up a level, and High wraps back to Low, then Normal", async () => {
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const bars = await screen.findByRole("button", { name: "Gas level: Normal. Change" });
    // No separate level picker anywhere.
    expect(screen.queryByRole("radiogroup", { name: "Gas level" })).toBeNull();
    // Normal is the default: two bars, and no ceiling in the address.
    expect(document.querySelector('[data-fee="gas"] svg[data-level]')).toHaveAttribute("data-level", "2");
    expect(window.location.hash).not.toMatch(/tip\.ceiling=/);
    await userEvent.click(bars);
    // The level raises the gas price ceiling (in every tip mode), not the gas multiplier.
    await waitFor(() => expect(screen.getByRole("button", { name: "Gas level: High. Change" })).toBeInTheDocument());
    expect(window.location.hash).toMatch(/tip\.ceiling=/);
    expect(window.location.hash).not.toMatch(/tip\.gas=/);
    expect(document.querySelector('[data-fee="gas"] svg[data-level]')).toHaveAttribute("data-level", "3");
    await userEvent.click(screen.getByRole("button", { name: "Gas level: High. Change" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Gas level: Low. Change" })).toBeInTheDocument());
    expect(document.querySelector('[data-fee="gas"] svg[data-level]')).toHaveAttribute("data-level", "1");
    expect(window.location.hash).toMatch(/tip\.ceiling=/);
    await userEvent.click(screen.getByRole("button", { name: "Gas level: Low. Change" }));
    await waitFor(() => expect(window.location.hash).not.toMatch(/tip\.ceiling=/));
    expect(screen.getByRole("button", { name: "Gas level: Normal. Change" })).toBeInTheDocument();
  });

  it("steps with the arrow keys when focused, without wrapping", async () => {
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const bars = await screen.findByRole("button", { name: "Gas level: Normal. Change" });
    bars.focus();
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Gas level: Low. Change" })).toBeInTheDocument());
    expect(window.location.hash).toMatch(/tip\.ceiling=/);
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("button", { name: "Gas level: Low. Change" })).toBeInTheDocument();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Gas level: Normal. Change" })).toBeInTheDocument());
    expect(window.location.hash).not.toMatch(/tip\.ceiling=/);
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Gas level: High. Change" })).toBeInTheDocument());
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("button", { name: "Gas level: High. Change" })).toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Gas level: Normal. Change" })).toBeInTheDocument());
  });
});
