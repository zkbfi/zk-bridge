import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { PairConfig } from "@terminal/model/types";
import { samplePrices, type PriceMap, type PriceState } from "@zkb/react";
import { Shell } from "../../src/app/Shell";
import { buildTestServices } from "../render";
import { connectedWallet, disconnectedWallet, renderWithWallet } from "../app/support";
import { BridgeScreen } from "../../src/bridge/BridgeScreen";
import type { Services } from "../../src/app/services";
import { USDC_QUERY } from "./token-link";

/** What the mocked price layer answers; null lets the real (sample) prices through. */
const answer: { data: PriceMap | undefined; states: Map<string, PriceState>; mode: "real" | "mocked" } = { data: undefined, states: new Map(), mode: "real" };

/** What the pasted-token reader answers, and the RPC it was built for (the picker reads a pasted token through it). */
const reads: { rpcs: string[] } = { rpcs: [] };
vi.mock("../../src/bridge/custom-token", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/bridge/custom-token")>();
  return {
    ...original,
    erc20ReaderFor: (rpc: string) => {
      reads.rpcs.push(rpc);
      return async (_address: string, fn: string) => ({ symbol: "FROG", name: "Frog Coin", decimals: 18 })[fn as "symbol"];
    },
  };
});

vi.mock("../../src/bridge/use-prices", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/bridge/use-prices")>();
  return {
    ...original,
    usePrices: (tokens: Parameters<typeof original.usePrices>[0]) => {
      const real = original.usePrices(tokens);
      return answer.mode === "real" ? real : { data: answer.data, states: answer.states, error: null, isError: false, isFetching: false };
    },
  };
});

beforeEach(() => {
  window.localStorage.clear();
  answer.mode = "real";
  answer.data = undefined;
  answer.states = new Map();
  reads.rpcs = [];
});

const PAIR = FIXTURE_PAIR as PairConfig;
const link = (query: string): void => window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?${query}`);
const show = (query: string, connected = true, services = buildTestServices()) => {
  link(query);
  return renderWithWallet(<Shell />, { wallet: connected ? connectedWallet() : disconnectedWallet(), services });
};
const fromBand = () => screen.getByRole("region", { name: `You send from ${FIXTURE_PAIR.first.name}` });
const output = (): string => document.querySelector(".zb-amount-out")?.textContent ?? "";
const pillButton = () => screen.getByRole("button", { name: /^Delivery settings/ });
const openDrawer = async () => userEvent.click(pillButton());
const hash = (): string => decodeURIComponent(window.location.hash);
const settle = async (query: string, connected = true, services?: ReturnType<typeof buildTestServices>) => {
  show(query, connected, services);
  await screen.findByRole("button", { name: /^Delivery settings/ }, { timeout: 4000 });
};

describe("a pair with no token on either chain", () => {
  const bare = (): PairConfig => ({
    ...PAIR,
    first: { ...PAIR.first, contracts: { ...PAIR.first.contracts, wrappedNative: null } },
    second: { ...PAIR.second, contracts: { ...PAIR.second.contracts, wrappedNative: null } },
  });
  const services = () => {
    const base = buildTestServices();
    return { ...base, pair: bare(), dataSource: { ...base.dataSource, listTokens: async () => [] } };
  };

  it("shows no token button, an empty output and a flip that carries no token", async () => {
    show("bridge.amount=5&tip.mode=fixed", true, services());
    await screen.findByRole("button", { name: /^From /, expanded: false });
    expect(screen.queryByRole("button", { name: /^Token: / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delivery settings/ })).toBeNull();
    expect(output()).toBe("0");
    expect(document.querySelector(".zb-balance .zb-right")).toBeEmptyDOMElement();
    await userEvent.click(screen.getByRole("button", { name: /^Flip: send from / }));
    await waitFor(() => expect(hash()).toMatch(/dir=second-to-first/));
    expect(hash()).not.toMatch(/bridge\.token/);
    expect(hash()).toMatch(/bridge\.amount=5/);
  });
});

describe("a base fee of zero", () => {
  it("still gives the gas bars a ceiling to read and write (at least 1 wei)", async () => {
    await settle(`${USDC_QUERY}&bridge.amount=50`, true, buildTestServices({ report: { baseFeeWei: 0n } }));
    await openDrawer();
    expect(screen.getByRole("slider", { name: "Gas level" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Gas level: Normal/ })).toBeInTheDocument();
  });
});

/** Answers every price key with one state, whatever the screen asks about. */
class EveryKey extends Map<string, PriceState> {
  constructor(private readonly state: PriceState) {
    super();
  }
  override get(): PriceState {
    return this.state;
  }
}
const unpriced = (): void => {
  answer.mode = "mocked";
  answer.data = undefined;
  answer.states = new EveryKey({ kind: "no-market" });
};
const exact = (label: string, value: string): void => {
  fireEvent.change(screen.getByRole("textbox", { name: `${label}, exact` }), { target: { value } });
};
const slider = (label: string): HTMLInputElement => screen.getByRole("slider", { name: label });
const bars = () => screen.getByRole("button", { name: /^Gas level: / });
const deliverMode = async (name: string) => userEvent.click(within(screen.getByRole("radiogroup", { name: "Who delivers" })).getByRole("radio", { name }));

describe("the cap and the share a link carries", () => {
  it("falls back to the stored automatic cap when the link's cap is zero", async () => {
    await settle(`${USDC_QUERY}&bridge.amount=50&tip.cap=0`);
    await openDrawer();
    expect(screen.getByRole("textbox", { name: "Automatic fee cap, exact" })).toHaveValue("1");
  });

  it("reads a share of zero as zero, not as the default", async () => {
    await settle(`${USDC_QUERY}&bridge.amount=50&tip.mode=percentage&tip.percent=0`);
    await openDrawer();
    expect(slider("Tip").valueAsNumber).toBe(0);
    expect(screen.getByText("Set by you · the automatic fee is off")).toBeInTheDocument();
  });
});

describe("the amount field", () => {
  it("drops the amount from the address when it is cleared, leaving no form at all", async () => {
    show("");
    const input = await within(fromBand()).findByRole("textbox", { name: /Amount to send/ });
    await userEvent.type(input, "5");
    await waitFor(() => expect(hash()).toMatch(/bridge\.amount=5/));
    await userEvent.clear(input);
    await waitFor(() => expect(hash()).not.toMatch(/bridge\./));
  });

  it("closes the route menu when the From pill is pressed again", async () => {
    show("");
    const from = await screen.findByRole("button", { name: /^From .*Change the route/ });
    await userEvent.click(from);
    expect(screen.getByRole("menu", { name: "Route" })).toBeInTheDocument();
    await userEvent.click(from);
    expect(screen.queryByRole("menu", { name: "Route" })).toBeNull();
  });
});

describe("the gas level in the drawer", () => {
  it("writes a ceiling typed in gwei for an automatic fee, and ignores a slider dragged to zero", async () => {
    await settle(`${USDC_QUERY}&bridge.amount=50`);
    await openDrawer();
    exact("Gas level", "20");
    await waitFor(() => expect(hash()).toMatch(/tip\.ceiling=20/));
    const before = hash();
    fireEvent.change(slider("Gas level"), { target: { value: "0" } });
    expect(hash()).toBe(before);
  });

  it("keeps a tip the user set when a ceiling is typed, rebasing it on the level's cost", async () => {
    await settle(`${USDC_QUERY}&bridge.amount=500&tip.mode=percentage&tip.percent=0.21`);
    await openDrawer();
    exact("Gas level", "100");
    await waitFor(() => expect(hash()).toMatch(/tip\.ceiling=100/));
    expect(hash()).toMatch(/tip\.percent=0\.2\d+/);
  });

  it("without a price a share the user set stays as it is when the bars move", async () => {
    unpriced();
    await settle(`${USDC_QUERY}&bridge.amount=500&tip.mode=percentage&tip.percent=0.5`);
    await userEvent.click(bars());
    await waitFor(() => expect(bars()).toHaveAccessibleName("Gas level: High. Change"));
    expect(hash()).toMatch(/tip\.percent=0\.5(&|$)/);
    // A typed ceiling is written too, with no price to rebase the share on.
    await openDrawer();
    exact("Gas level", "50");
    await waitFor(() => expect(hash()).toMatch(/tip\.ceiling=50/));
    expect(hash()).toMatch(/tip\.percent=0\.5(&|$)/);
  });
});

describe("the fixed fee", () => {
  it("with no amount typed has nothing to recommend and reads as zero", async () => {
    await settle(`${USDC_QUERY}&tip.mode=fixed`);
    await openDrawer();
    expect(slider("Fixed fee").valueAsNumber).toBe(0);
    expect(screen.getByRole("textbox", { name: "Fixed fee, exact" })).toHaveValue("");
    expect(screen.getByText("A fixed fee you set")).toBeInTheDocument();
  });

  it("starts from the fee in force when the link names no fixed amount, and writes what is typed", async () => {
    await settle(`${USDC_QUERY}&bridge.amount=50&tip.mode=fixed`);
    await openDrawer();
    expect(screen.getByRole("textbox", { name: "Fixed fee, exact" })).toHaveValue("");
    exact("Fixed fee", "0.5");
    await waitFor(() => expect(hash()).toMatch(/tip\.fixed=0\.5/));
    exact("Fixed fee", "abc");
    expect(await screen.findByText(/Enter an amount of USDC with at most 6 decimals\./)).toBeInTheDocument();
    exact("Fixed fee", "9999");
    expect(await screen.findByText("The fee can't be more than the amount.")).toBeInTheDocument();
    fireEvent.change(slider("Fixed fee"), { target: { value: "0.25" } });
    await waitFor(() => expect(hash()).toMatch(/tip\.fixed=0\.25/));
    await userEvent.click(screen.getAllByRole("button", { name: "Reset to recommended" })[0]!);
    await waitFor(() => expect(hash()).toMatch(/tip\.fixed=\d/));
  });

  it("without a price has no 2x cost tick and reads the fee in the token", async () => {
    unpriced();
    await settle(`${USDC_QUERY}&bridge.amount=500&tip.mode=fixed&tip.fixed=1`);
    await openDrawer();
    expect(slider("Fixed fee").valueAsNumber).toBe(1);
    expect(screen.queryByTitle("2× cost")).toBeNull();
  });
});

describe("the gas-based fee", () => {
  it("reads a multiple of zero as zero, and moves with the slider", async () => {
    await settle(`${USDC_QUERY}&bridge.amount=500&tip.mode=gas-multiplier&tip.gas=0`);
    await openDrawer();
    expect(slider("Fee on gas").valueAsNumber).toBe(0);
    fireEvent.change(slider("Fee on gas"), { target: { value: "3" } });
    await waitFor(() => expect(hash()).toMatch(/tip\.gas=3/));
    exact("Fee on gas", "0");
    expect(await screen.findByText("Use a number above 0 and at most 1000.")).toBeInTheDocument();
  });

  it("without a price says its worst case in the token, and spans the fee as shares of the amount", async () => {
    unpriced();
    await settle(`${USDC_QUERY}&bridge.amount=500&tip.mode=gas-multiplier&tip.gas=2`);
    await openDrawer();
    expect(slider("Fee on gas").valueAsNumber).toBe(2);
  });
});

describe("the caps", () => {
  it("lowering the hard cap under a link's automatic cap takes the automatic cap down to the stored one", async () => {
    await settle(`${USDC_QUERY}&bridge.amount=50&tip.cap=1.5`);
    await openDrawer();
    exact("Hard fee cap", "1");
    await waitFor(() => expect(hash()).not.toMatch(/tip\.cap/));
  });

  it("lowering the hard cap under a link's cap that differs from the stored one writes the new cap", async () => {
    await settle(`${USDC_QUERY}&bridge.amount=50&tip.cap=1.9`);
    await openDrawer();
    exact("Hard fee cap", "1.5");
    await waitFor(() => expect(hash()).toMatch(/tip\.cap=1\.5/));
  });

  it("saving a lowered cap with no tip in the link stores it and leaves the link as it is", async () => {
    await settle(`${USDC_QUERY}&bridge.amount=50`);
    await openDrawer();
    exact("Hard fee cap", "0.5");
    const save = await screen.findByRole("button", { name: "Save 0.5% as your default cap" });
    await userEvent.click(save);
    await waitFor(() => expect(window.localStorage.getItem("zk-bridge-explorer.fee-cap")).toBe("0.5"));
    expect(hash()).not.toMatch(/tip\.cap/);
  });

  it("does not drop the link's cap when the store refuses it (a cap above the stored hard cap)", async () => {
    await settle(`${USDC_QUERY}&bridge.amount=50`);
    await openDrawer();
    exact("Hard fee cap", "5");
    exact("Automatic fee cap", "4");
    await waitFor(() => expect(hash()).toMatch(/tip\.cap=4/));
    await userEvent.click(screen.getByRole("button", { name: "Save 4% as your default cap" }));
    expect(hash()).toMatch(/tip\.cap=4/);
    expect(window.localStorage.getItem("zk-bridge-explorer.fee-cap")).toBeNull();
  });
});

describe("choosing who delivers", () => {
  it("keeps the fee where it is across the modes, and hands it back to the rule on Automatic", async () => {
    await settle(`${USDC_QUERY}&bridge.amount=50`);
    await openDrawer();
    await deliverMode("Share");
    await waitFor(() => expect(hash()).toMatch(/tip\.percent=/));
    await deliverMode("Fixed");
    await waitFor(() => expect(hash()).toMatch(/tip\.mode=fixed/));
    expect(hash()).toMatch(/tip\.fixed=/);
    await deliverMode("Gas-based");
    await waitFor(() => expect(hash()).toMatch(/tip\.mode=gas-multiplier/));
    await deliverMode("No tip");
    await waitFor(() => expect(hash()).toMatch(/tip\.mode=none/));
    await deliverMode("Automatic");
    await waitFor(() => expect(hash()).not.toMatch(/tip\.percent/));
    expect(hash()).toMatch(/tip\.mode=percentage/);
  });

  it("takes a share already in the link for Share, and a fixed fee with no amount yet carries no amount", async () => {
    await settle(`${USDC_QUERY}&tip.mode=percentage&tip.percent=0.3`);
    await openDrawer();
    await deliverMode("Fixed");
    await waitFor(() => expect(hash()).toMatch(/tip\.mode=fixed/));
    expect(hash()).not.toMatch(/tip\.fixed=/);
    await deliverMode("Share");
    await waitFor(() => expect(hash()).toMatch(/tip\.percent=\d/));
    expect(pillButton()).toHaveTextContent(/Deliver for/);
  });
});

describe("the bridge pill", () => {
  it("asks for a wallet when there is none", async () => {
    const connect = vi.fn(async () => undefined);
    link(`${USDC_QUERY}&bridge.amount=5`);
    renderWithWallet(<Shell />, { wallet: disconnectedWallet({ connect }) });
    await userEvent.click(await screen.findByRole("button", { name: "Connect wallet", description: "" }).catch(() => screen.getAllByRole("button", { name: "Connect wallet" }).at(-1)!));
    expect(connect).toHaveBeenCalled();
    await userEvent.click(document.querySelector<HTMLElement>(".zb-go")!);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".zb-sheet")).toBeNull();
  });
});

const goPill = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>(".zb-go")!;
const openReview = async (query: string, services?: ReturnType<typeof buildTestServices>) => {
  await settle(query, true, services);
  await waitFor(() => expect(goPill()).not.toBeDisabled(), { timeout: 4000 });
  await userEvent.click(goPill());
  return screen.findByRole("dialog", { name: "Review" });
};

describe("the review sheet", () => {
  it("says there is no fee and names no router when nobody is tipped, and keeps the fee out of the arrival", async () => {
    const sheet = await openReview(`${USDC_QUERY}&bridge.amount=50&tip.mode=none`);
    expect(within(sheet).getByText("Fee").nextElementSibling).toHaveTextContent("none");
    expect(within(sheet).queryByText("Relay router")).toBeNull();
    expect(within(sheet).getByText("Arrives").nextElementSibling).toHaveTextContent("50");
  });

  it("without a price shows the fee in the token alone, with no dollar figure", async () => {
    unpriced();
    const sheet = await openReview(`${USDC_QUERY}&bridge.amount=500`);
    const fee = within(sheet).getByText("Fee").nextElementSibling!;
    expect(fee.textContent).toMatch(/USDC/);
    expect(fee.textContent).not.toMatch(/about/);
    expect(within(sheet).getByText("Relay router")).toBeInTheDocument();
  });

  it("blocks Confirm and says why when the draft stops being ready while the sheet is open", async () => {
    const sheet = await openReview(`${USDC_QUERY}&bridge.amount=50`);
    expect(within(sheet).getByRole("button", { name: "Confirm in wallet" })).toBeEnabled();
    expect(sheet.querySelector(".zb-verdict")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: /Amount to send/, hidden: true }), { target: { value: "99999999999" } });
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "Confirm in wallet" })).toBeDisabled());
  });

  it("offers to raise the hard cap when a change under the open sheet puts the fee above it", async () => {
    const sheet = await openReview(`${USDC_QUERY}&bridge.amount=500&tip.mode=percentage&tip.percent=0.5`);
    await userEvent.click(screen.getByRole("button", { name: /^Delivery settings/, hidden: true }));
    fireEvent.change(screen.getByRole("textbox", { name: "Hard fee cap, exact", hidden: true }), { target: { value: "0.1" } });
    const notice = await within(sheet).findByRole("group", { name: "Hard fee cap" });
    await userEvent.click(within(notice).getByRole("button", { name: /^Raise cap to / }));
    await waitFor(() => expect(within(sheet).queryByRole("group", { name: "Hard fee cap" })).toBeNull());
  });
});

describe("a route that is paused", () => {
  it("says so on the pill and blocks it", async () => {
    const base = buildTestServices();
    const dataSource = { ...base.dataSource, listPairs: async () => (await base.dataSource.listPairs()).map((entry) => ({ ...entry, gates: { first: "stop" as const, second: "open" as const } })) };
    await settle(`${USDC_QUERY}&bridge.amount=5`, true, { ...base, dataSource });
    await waitFor(() => expect(goPill()).toHaveTextContent(/is paused$/));
    expect(goPill()).toBeDisabled();
  });
});

describe("the route menu on the bridge screen", () => {
  const known = (...ids: string[]): Services["knownPairs"] => ids.map((id) => ({ id, label: id, configured: true, active: id === FIXTURE_PAIR.id }));

  it("moves to the other direction of the same pair in place, keeping the amount", async () => {
    show("bridge.amount=7", true, { ...buildTestServices(), knownPairs: known(FIXTURE_PAIR.id) });
    await userEvent.click(await screen.findByRole("button", { name: /^From .*Change the route/ }));
    await userEvent.click(within(screen.getByRole("menu", { name: "Route" })).getByRole("menuitemradio", { name: /PulseChain → Ethereum/ }));
    await waitFor(() => expect(hash()).toMatch(/dir=second-to-first/));
    expect(hash()).toMatch(/bridge\.amount=7/);
    expect(screen.queryByRole("menu", { name: "Route" })).toBeNull();
  });

  it("moves without an amount when none was typed", async () => {
    show("", true, { ...buildTestServices(), knownPairs: known(FIXTURE_PAIR.id) });
    await userEvent.click(await screen.findByRole("button", { name: /^From .*Change the route/ }));
    await userEvent.click(within(screen.getByRole("menu", { name: "Route" })).getByRole("menuitemradio", { name: /PulseChain → Ethereum/ }));
    await waitFor(() => expect(hash()).toMatch(/dir=second-to-first/));
    expect(hash()).not.toMatch(/bridge\./);
  });

  it("loads the page afresh for a route of another pair, since the services are built for one pair", async () => {
    const onRoute = vi.fn();
    window.history.replaceState(null, "", "#/bridge/eth-pls");
    renderWithWallet(<BridgeScreen route={{ name: "bridge", pairId: FIXTURE_PAIR.id, dir: "first-to-second", form: { amount: "3" } }} onRoute={onRoute} fixture />, {
      wallet: disconnectedWallet(),
      services: { ...buildTestServices(), knownPairs: known(FIXTURE_PAIR.id, "sepolia-pls943") },
    });
    await userEvent.click(await screen.findByRole("button", { name: /^From .*Change the route/ }));
    await userEvent.click(within(screen.getByRole("menu", { name: "Route" })).getByRole("menuitemradio", { name: /Sepolia → PulseChain v4/ }));
    // The address names the other pair and keeps the amount; the screen itself does not route in place.
    expect(hash()).toMatch(/#\/bridge\/sepolia-pls943/);
    expect(hash()).toMatch(/bridge\.amount=3/);
    expect(onRoute).not.toHaveBeenCalled();
  });
});

describe("the sample banner", () => {
  const route = { name: "bridge" as const, pairId: FIXTURE_PAIR.id, dir: "first-to-second" as const };
  it("shows for sample data and is gone for live data", () => {
    const view = renderWithWallet(<BridgeScreen route={route} onRoute={() => undefined} fixture />, { wallet: disconnectedWallet() });
    expect(screen.getByText("Sample data. Nothing here reaches a chain.")).toBeInTheDocument();
    view.unmount();
    renderWithWallet(<BridgeScreen route={route} onRoute={() => undefined} fixture={false} />, { wallet: disconnectedWallet() });
    expect(screen.queryByText(/Sample data/)).toBeNull();
  });
});

describe("a token pasted into the picker", () => {
  const FROG = "0x9999999999999999999999999999999999999999";
  const paste = async (services?: ReturnType<typeof buildTestServices>) => {
    show("", true, services);
    await userEvent.click(await screen.findByRole("button", { name: /^Token:/ }));
    const picker = await screen.findByRole("dialog", { name: "Choose a token" });
    await userEvent.type(within(picker).getByRole("combobox", { name: "Search tokens" }), FROG);
    return picker;
  };

  it("is read over the RPC the user chose, then picked and kept in the list", async () => {
    const services = { ...buildTestServices(), connection: { resolved: () => ({ rpcUrls: { [FIXTURE_PAIR.first.chainId]: { value: "https://chosen.example/rpc" } } }) } as unknown as Services["connection"] };
    const picker = await paste(services);
    await userEvent.click(await within(picker).findByRole("option", { name: /FROG/ }));
    await waitFor(() => expect(hash()).toMatch(new RegExp(`bridge\\.token=first:${FROG}`, "i")));
    expect(reads.rpcs).toContain("https://chosen.example/rpc");
    // The pasted token is now in the list: choosing it again adds nothing new.
    await userEvent.click(await screen.findByRole("button", { name: /^Token: FROG/ }));
    const again = await screen.findByRole("dialog", { name: "Choose a token" });
    await userEvent.type(within(again).getByRole("combobox", { name: "Search tokens" }), FROG);
    await userEvent.click(await within(again).findByRole("option", { name: /FROG/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose a token" })).toBeNull());
  });

  it("is read over the configured RPC when the user chose none", async () => {
    const base = buildTestServices();
    const picker = await paste({ ...base, configuration: { ...base.configuration, rpcUrls: { [FIXTURE_PAIR.first.chainId]: "https://configured.example/rpc" } } });
    await within(picker).findByRole("option", { name: /FROG/ });
    expect(reads.rpcs).toContain("https://configured.example/rpc");
  });

  it("is not read at all for a chain with no RPC to read it over", async () => {
    const base = buildTestServices();
    const odd: PairConfig = { ...PAIR, first: { ...PAIR.first, chainId: 424242 } };
    const picker = await paste({ ...base, pair: odd });
    await waitFor(() => expect(within(picker).queryByRole("option", { name: /FROG/ })).toBeNull());
    expect(reads.rpcs).toEqual([]);
  });
});

describe("the token picker without a wallet or a price", () => {
  it("lists the tokens with no balance and no price", async () => {
    unpriced();
    show("", false);
    await userEvent.click(await screen.findByRole("button", { name: /^Token:/ }));
    const picker = await screen.findByRole("dialog", { name: "Choose a token" });
    expect(within(picker).getAllByRole("option").length).toBeGreaterThan(0);
    expect(picker.textContent).not.toMatch(/\$/);
  });
});

/** The native coin is priced; the token is not (a token with no pool). */
const nativeOnly = (): void => {
  answer.mode = "mocked";
  const tokenKey = `first:${FIXTURE_TOKENS.find((token) => token.side === "first")!.address}`;
  answer.data = new Map([...samplePrices(FIXTURE_TOKENS, PAIR)].filter(([key]) => key !== tokenKey));
  answer.states = new EveryKey({ kind: "known" });
};

describe("without a price for the token", () => {
  it("blocks a share above the hard cap and names the fee and the cap in the token alone", async () => {
    unpriced();
    await settle(`${USDC_QUERY}&bridge.amount=500&tip.mode=percentage&tip.percent=5`);
    await waitFor(() => expect(goPill()).toHaveTextContent(/^Fee above your 2% cap$/));
    expect(goPill()).toBeDisabled();
    const detail = document.querySelector(".zb-verdict")!.textContent ?? "";
    expect(detail).toMatch(/The fee is 25 USDC, more than your 2% hard cap \(10 USDC\)/);
    expect(detail).not.toMatch(/\$/);
    expect(screen.getByRole("button", { name: /^Raise cap to / })).toBeInTheDocument();
  });

  it("moves the share from the Fee slider and from its exact box, writing it as typed", async () => {
    unpriced();
    await settle(`${USDC_QUERY}&bridge.amount=500`);
    await openDrawer();
    fireEvent.change(slider("Fee"), { target: { value: "0.3" } });
    await waitFor(() => expect(hash()).toMatch(/tip\.mode=percentage.*tip\.percent=0\.3(&|$)|tip\.percent=0\.3.*tip\.mode=percentage/));
    exact("Fee", "0.45");
    await waitFor(() => expect(hash()).toMatch(/tip\.percent=0\.45(&|$)/));
    exact("Fee", "250");
    expect(await screen.findByText("Use a number from 0 to 100.")).toBeInTheDocument();
  });

  it("says a gas-based fee's worst case in the token", async () => {
    unpriced();
    await settle(`${USDC_QUERY}&bridge.amount=500&tip.mode=gas-multiplier&tip.gas=2&tip.price=100`);
    await waitFor(() => expect(pillButton()).toHaveTextContent(/max [\d.]+ USDC/));
    await openDrawer();
    expect(screen.getAllByRole("img", { name: /of the amount$/ }).length).toBeGreaterThan(0);
  });

  it("has no 2x cost tick for a fixed fee when only the native coin is priced", async () => {
    nativeOnly();
    await settle(`${USDC_QUERY}&bridge.amount=500&tip.mode=fixed&tip.fixed=1&tip.price=100`);
    await openDrawer();
    expect(slider("Fixed fee").valueAsNumber).toBe(1);
    expect(screen.queryByTitle("2× cost")).toBeNull();
  });
});

describe("a fixed fee with a price", () => {
  it("starts the exact box at the fee in force when the link names none", async () => {
    await settle(`${USDC_QUERY}&bridge.amount=50&tip.mode=fixed&tip.price=100`);
    await openDrawer();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Fixed fee, exact" })).toHaveValue("0.1848"));
  });
});

describe("the From row without a wallet", () => {
  it("connects from the row, and shows the sending account once there is one", async () => {
    const connect = vi.fn(async () => undefined);
    link("");
    renderWithWallet(<Shell />, { wallet: disconnectedWallet({ connect }) });
    const row = (await screen.findByRole("button", { name: /^From .*Change the route/ })).parentElement!;
    await userEvent.click(within(row).getByRole("button", { name: "Connect wallet" }));
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe("the destination lock", () => {
  it("explains itself while the pointer is on it and stops when it leaves", async () => {
    show("");
    const lock = await screen.findByRole("button", { name: /^Destination locked/ });
    await userEvent.hover(lock);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Sends to your connected wallet");
    await userEvent.unhover(lock);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("the token picker with prices", () => {
  it("shows each token's price in the list", async () => {
    show("");
    await userEvent.click(await screen.findByRole("button", { name: /^Token:/ }));
    const picker = await screen.findByRole("dialog", { name: "Choose a token" });
    await waitFor(() => expect(picker.textContent).toMatch(/\$/));
  });
});

describe("closing the token picker", () => {
  it("leaves the token as it was, by the close button or Escape", async () => {
    show("");
    const token = await screen.findByRole("button", { name: /^Token:/ });
    const name = token.getAttribute("aria-label");
    await userEvent.click(token);
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Choose a token" })).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Choose a token" })).toBeNull();
    await userEvent.click(token);
    await screen.findByRole("dialog", { name: "Choose a token" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose a token" })).toBeNull());
    expect(screen.getByRole("button", { name: /^Token:/ })).toHaveAttribute("aria-label", name);
  });
});

describe("a token pasted while sending from the second chain", () => {
  it("is read on that chain", async () => {
    const FROG = "0x9999999999999999999999999999999999999999";
    show("dir=second-to-first");
    await userEvent.click(await screen.findByRole("button", { name: /^Token:/ }));
    const picker = await screen.findByRole("dialog", { name: "Choose a token" });
    await userEvent.type(within(picker).getByRole("combobox", { name: "Search tokens" }), FROG);
    await userEvent.click(await within(picker).findByRole("option", { name: /FROG/ }));
    await waitFor(() => expect(hash()).toMatch(new RegExp(`bridge\\.token=second:${FROG}`, "i")));
    expect(hash()).toMatch(/dir=second-to-first/);
  });
});
