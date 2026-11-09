/**
 * Every transaction the dapp can put in front of the wallet must decode in the review, or the page refuses to send it.
 * Regression (2026-11-08, live dapp next.16): a 0.1 SepETH wrap on Sepolia through the DeliveryRouter
 * (`wrapAndRelayTokens(address)`) was refused with "The page cannot read this call from its bytes", because the review
 * decoded with an ABI list that held no router functions. The native coin with a tip goes to the same router as
 * `relayTokensAndCall(address,bytes,uint256)`, which must decode too.
 */
import { encodeFunctionData, erc20Abi, getAddress, parseAbi, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { deliveryRouterAbi, tokenMediatorAbi, type GateConfirmation } from "@zk-bridge/shared";
import { buildMessageSteps } from "@terminal/app/actions";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { ChainConfig, PairConfig } from "@terminal/model/types";
import { buildConfirmView } from "../../src/tx/confirm-model";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS } from "../../src/tx/bridge-draft";
import { planBridgeSteps, type BridgeFormValues, type WebStep } from "../../src/tx/bridge-steps";
import { planGateConfirm } from "../../src/tx/gate-check";
import { NO_ROUTER_NOTICE, WRAP_NO_FEE_NOTICE } from "../../src/tx/tip-copy";
import { buildDeliveryReport, buildFixtureContext } from "../helpers";

const usdc = FIXTURE_TOKENS[0]!;
const owner = getAddress("0x8D43a3DF4951652d04bA29098D292136Af004Bdd");
const sepoliaRouter = getAddress("0x3846e483C98cD0f164c29A5e40F7295A5765ABa4");

/** Sepolia as the owner's release saw it: tonight's first Sepolia router, a gate that enforces. */
const SEPOLIA: ChainConfig = {
  ...FIXTURE_PAIR.first,
  chainId: 11155111,
  name: "Sepolia",
  nativeSymbol: "SepETH",
  contracts: { ...FIXTURE_PAIR.first.contracts, deliveryRouter: sepoliaRouter },
};
const SEPOLIA_PAIR: PairConfig = { ...FIXTURE_PAIR, id: "sepolia-pls943", first: SEPOLIA };

const values = (overrides: Partial<BridgeFormValues> = {}): BridgeFormValues => ({
  token: `first:${usdc.address}`,
  amount: "250",
  receiver: owner,
  mode: "plain",
  data: "",
  callGas: "",
  callbackGas: "",
  ...overrides,
});

const noDisclosure = { feesApplyTo: "this-transaction", destinationNativeSymbol: null, destinationChainId: null, amountToken: null, delivery: null } as const;

const gateConfirmStep = (chain: ChainConfig): WebStep => {
  const evidence: Hex = `0x${"ab".repeat(40)}`;
  const answer = {
    kind: "confirm",
    call: { to: chain.contracts.gate as Address, data: encodeFunctionData({ abi: parseAbi(["function confirm(bytes evidence)"]), functionName: "confirm", args: [evidence] }) },
    gas: 150_000n,
    epoch: 360_442n,
    forkVersion: "0x90000075",
    shape: 6,
    validUntil: 1_762_502_400n,
    evidence: { encoded: evidence, header: { slot: 11_534_144n } },
  } as unknown as Extract<GateConfirmation, { kind: "confirm" }>;
  return { plan: planGateConfirm(chain, answer), disclosure: noDisclosure, gateConfirm: { epoch: 360_442n, gas: 150_000n, validUntil: 1_762_502_400n } };
};

const expectSendable = (step: WebStep, signature: string): void => {
  const view = buildConfirmView(step);
  expect(view.functionSignature).toBe(signature);
  expect(view.blockedReason).toBeNull();
  expect(view.arguments.length).toBe(step.plan.arguments.length);
};

describe("the owner's case: gate confirm, then 0.1 SepETH wrapped and relayed on Sepolia", () => {
  it("decodes wrapAndRelayTokens(address) on the router and allows the send", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 0n });
    const steps = planBridgeSteps({ values: values({ token: "first:native", amount: "0.1" }), tokens, context: { ...context, pair: SEPOLIA_PAIR }, delivery: null });
    expect(steps).toHaveLength(1);
    const wrap = steps[0]!;
    expect(wrap.plan.to).toBe(sepoliaRouter);
    expect(wrap.plan.value).toBe(10n ** 17n);
    expect(wrap.plan.data.slice(0, 10)).toBe("0xf52cbf0e");

    const view = buildConfirmView(wrap);
    expect(view.blockedReason).toBeNull();
    expect(view.functionSignature).toBe("wrapAndRelayTokens(address)");
    expect(view.arguments).toEqual([{ name: "receiver", type: "address", value: owner }]);
    expect(view.valueText).toBe("0.1 SepETH");
    expect(view.contractText).toBe(`DeliveryRouter at ${sepoliaRouter}`);
  });

  it("says the router wraps and relays with no fee, not that no router is involved", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 0n });
    const [wrap] = planBridgeSteps({ values: values({ token: "first:native", amount: "0.1" }), tokens, context: { ...context, pair: SEPOLIA_PAIR }, delivery: null });
    const view = buildConfirmView(wrap!);
    expect(view.noRouterNotice).toBe(WRAP_NO_FEE_NOTICE);
    expect(view.noRouterNotice).not.toMatch(/No router is involved/);
    expect(view.noRouterNotice).toMatch(/router/);
  });

  it("decodes the gate confirm that goes before it", () => {
    expectSendable(gateConfirmStep(SEPOLIA), "confirm(bytes)");
  });
});

describe("every send the dapp can produce decodes in the review", () => {
  it("relayTokens(address,address,uint256), a plain relay, keeps the no-router notice", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const [relay] = planBridgeSteps({ values: values(), tokens, context, delivery: null });
    expectSendable(relay!, "relayTokens(address,address,uint256)");
    expect(buildConfirmView(relay!).noRouterNotice).toBe(NO_ROUTER_NOTICE);
  });

  it("relayTokens(address,uint256), the short form", () => {
    const step: WebStep = {
      plan: {
        title: "Relay",
        chain: FIXTURE_PAIR.first,
        to: FIXTURE_PAIR.first.contracts.tokenMediator,
        contractLabel: "ERC-20 mediator",
        functionSignature: "relayTokens(address,uint256)",
        functionName: "relayTokens",
        data: encodeFunctionData({ abi: tokenMediatorAbi, functionName: "relayTokens", args: [usdc.address, 5n] }),
        value: 0n,
        arguments: [
          { name: "token", type: "address", value: usdc.address },
          { name: "value", type: "uint256", value: "5" },
        ],
        notes: [],
      },
      disclosure: noDisclosure,
    };
    expectSendable(step, "relayTokens(address,uint256)");
  });

  it("relayTokensAndCall with a callback gas, without a tip", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const [relay] = planBridgeSteps({ values: values({ mode: "call", data: "0xabcd", callbackGas: "1100000" }), tokens, context, delivery: null });
    expectSendable(relay!, "relayTokensAndCall(address,address,uint256,bytes,uint256)");
    expect(buildConfirmView(relay!).arguments.at(-1)?.value).toBe("1100000");
  });

  it("relayTokensAndCall to the router with a tip, and the approval before it", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 0n });
    const draft = computeBridgeDraft(values(), { ...DEFAULT_DELIVERY_OPTIONS, senderPriceText: "1", mode: "percentage" }, { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n });
    expect(draft.status).toBe("ready");
    const [approve, relay] = draft.steps;
    expectSendable(approve!, "approve(address,uint256)");
    expectSendable(relay!, "relayTokensAndCall(address,address,uint256,bytes,uint256)");
    expect(buildConfirmView(relay!).delivery).not.toBeNull();
  });

  it("relayTokensAndCall(address,bytes,uint256) on the router: the native coin with a tip, the default for SepETH", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 0n });
    const draft = computeBridgeDraft(values({ token: "first:native", amount: "0.1" }), { ...DEFAULT_DELIVERY_OPTIONS, mode: "percentage" }, { pair: SEPOLIA_PAIR, tokens, context: { ...context, pair: SEPOLIA_PAIR }, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n });
    expect(draft.status).toBe("ready");
    expect(draft.steps).toHaveLength(1);
    const relay = draft.steps[0]!;
    expect(relay.plan.to).toBe(sepoliaRouter);
    expectSendable(relay, "relayTokensAndCall(address,bytes,uint256)");
    const view = buildConfirmView(relay);
    expect(view.delivery).not.toBeNull();
    expect(view.noRouterNotice).toBeNull();
    expect(view.valueText).toBe("0.1 SepETH");
    expect(view.arguments.map((argument) => argument.name)).toEqual(["receiver", "data", "callbackGas"]);
    expect(getAddress(view.arguments[0]!.value)).toBe(getAddress(SEPOLIA_PAIR.second.contracts.deliveryRouter!));
    expect(view).toMatchObject({ amountText: "0.1 SepETH", destinationText: "to 0x8D43…4Bdd on PulseChain" });
  });

  it("refuses a router relayTokensAndCall whose terms differ from the ones shown", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 0n });
    const draft = computeBridgeDraft(values({ token: "first:native", amount: "0.1" }), { ...DEFAULT_DELIVERY_OPTIONS, mode: "percentage" }, { pair: SEPOLIA_PAIR, tokens, context: { ...context, pair: SEPOLIA_PAIR }, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n });
    const relay = draft.steps[0]!;
    const shown = relay.disclosure.delivery!;
    const tampered: WebStep = { ...relay, disclosure: { ...relay.disclosure, delivery: { ...shown, director: { ...shown.director, multiplier: shown.director.multiplier + 1n } } } };
    expect(buildConfirmView(tampered).blockedReason).toBe("The fee director in the call data differs from the one that was shown. Nothing was sent.");
  });

  it("approve(address,uint256) on its own", () => {
    const step: WebStep = {
      plan: {
        title: "Allow",
        chain: FIXTURE_PAIR.first,
        to: usdc.address,
        contractLabel: "USDC",
        functionSignature: "approve(address,uint256)",
        functionName: "approve",
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [FIXTURE_PAIR.first.contracts.tokenMediator, 7n] }),
        value: 0n,
        arguments: [
          { name: "spender", type: "address", value: FIXTURE_PAIR.first.contracts.tokenMediator },
          { name: "amount", type: "uint256", value: "7" },
        ],
        notes: [],
      },
      disclosure: noDisclosure,
    };
    expectSendable(step, "approve(address,uint256)");
  });

  it("wrapAndRelayTokens() and wrapAndRelayTokens(address) both decode", () => {
    for (const [args, signature] of [
      [[], "wrapAndRelayTokens()"],
      [[owner], "wrapAndRelayTokens(address)"],
    ] as const) {
      const step: WebStep = {
        plan: {
          title: "Wrap",
          chain: SEPOLIA,
          to: sepoliaRouter,
          contractLabel: "DeliveryRouter",
          functionSignature: signature,
          functionName: "wrapAndRelayTokens",
          data: encodeFunctionData({ abi: deliveryRouterAbi, functionName: "wrapAndRelayTokens", args: args as never }),
          value: 1n,
          arguments: args.map((value) => ({ name: "receiver", type: "address", value })),
          notes: [],
        },
        disclosure: noDisclosure,
      };
      expectSendable(step, signature);
    }
  });

  it("requireToPassMessage from the message form", () => {
    const [send] = buildMessageSteps({ chain: "first", target: owner, data: "0x1234" }, FIXTURE_PAIR);
    expectSendable({ plan: send!.plan, disclosure: noDisclosure }, "requireToPassMessage(address,bytes,uint256)");
  });

  it("confirm(bytes) on the gate", () => {
    expectSendable(gateConfirmStep(FIXTURE_PAIR.first), "confirm(bytes)");
  });
});

describe("the headline: the amount and where it goes, read from the bytes", () => {
  it("names the wrapped amount and the receiver on the destination chain", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 0n });
    const [wrap] = planBridgeSteps({ values: values({ token: "first:native", amount: "0.1" }), tokens, context: { ...context, pair: SEPOLIA_PAIR }, delivery: null });
    const view = buildConfirmView(wrap!);
    expect(view.amountText).toBe("0.1 SepETH");
    expect(view.destinationText).toBe("to 0x8D43…4Bdd on PulseChain");
  });

  it("names the recipient after the tip, not the router, and the amount of an approval", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 0n });
    const draft = computeBridgeDraft(values(), { ...DEFAULT_DELIVERY_OPTIONS, senderPriceText: "1", mode: "percentage" }, { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n });
    const [approve, relay] = draft.steps;
    expect(buildConfirmView(relay!)).toMatchObject({ amountText: "250 USDC", destinationText: "to 0x8D43…4Bdd on PulseChain" });
    expect(buildConfirmView(approve!)).toMatchObject({ amountText: "250 USDC", destinationText: null });
  });

  it("says `your address` and `the other chain` when the bytes name no receiver and the step names no chain, and base units without a token", () => {
    const wrap: WebStep = {
      plan: { title: "Wrap", chain: SEPOLIA, to: sepoliaRouter, contractLabel: "DeliveryRouter", functionSignature: "wrapAndRelayTokens()", functionName: "wrapAndRelayTokens", data: encodeFunctionData({ abi: deliveryRouterAbi, functionName: "wrapAndRelayTokens", args: [] }), value: 5n * 10n ** 17n, arguments: [], notes: [] },
      disclosure: noDisclosure,
    };
    expect(buildConfirmView(wrap)).toMatchObject({ amountText: "0.5 SepETH", destinationText: "to your address on the other chain" });
    const relay: WebStep = {
      plan: { title: "Relay", chain: FIXTURE_PAIR.first, to: FIXTURE_PAIR.first.contracts.tokenMediator, contractLabel: "ERC-20 mediator", functionSignature: "relayTokens(address,uint256)", functionName: "relayTokens", data: encodeFunctionData({ abi: tokenMediatorAbi, functionName: "relayTokens", args: [usdc.address, 5n] }), value: 0n, arguments: [{ name: "token", type: "address", value: usdc.address }, { name: "value", type: "uint256", value: "5" }], notes: [] },
      disclosure: noDisclosure,
    };
    expect(buildConfirmView(relay)).toMatchObject({ amountText: "5 base units", destinationText: "to your address on the other chain" });
    // Planned as an approval, but the bytes are a relay: the headline names no amount, and the send is refused.
    const mislabelled = buildConfirmView({ ...relay, plan: { ...relay.plan, functionName: "approve", functionSignature: "approve(address,uint256)" } });
    expect(mislabelled.amountText).toBeNull();
    expect(mislabelled.blockedReason).toMatch(/^The bytes call relayTokens\(address,uint256\), but the page planned approve/);
  });

  it("names the target of a message, and nothing for a gate confirm or a call that does not decode", () => {
    const [send] = buildMessageSteps({ chain: "first", target: owner, data: "0x1234" }, FIXTURE_PAIR);
    expect(buildConfirmView({ plan: send!.plan, disclosure: noDisclosure })).toMatchObject({ amountText: null, destinationText: "to 0x8D43…4Bdd on the other chain" });
    expect(buildConfirmView(gateConfirmStep(SEPOLIA))).toMatchObject({ amountText: null, destinationText: null });
    const unknown = gateConfirmStep(SEPOLIA);
    const view = buildConfirmView({ ...unknown, plan: { ...unknown.plan, data: "0xdeadbeef" } });
    expect(view).toMatchObject({ amountText: null, destinationText: null, blockedReason: "The page cannot read this call from its bytes, so it will not send it." });
  });
});
