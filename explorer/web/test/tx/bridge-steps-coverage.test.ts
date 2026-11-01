import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { PlanInputError } from "@terminal/tx/plan";
import { planBridgeSteps, type BridgeFormValues } from "../../src/tx/bridge-steps";
import { buildFixtureContext } from "../helpers";

const usdc = FIXTURE_TOKENS[0]!;
const receiver = getAddress(`0x${"cd".repeat(20)}`);
const values = (overrides: Partial<BridgeFormValues> = {}): BridgeFormValues => ({ token: `first:${usdc.address}`, amount: "250", receiver, mode: "plain", data: "", callGas: "", callbackGas: "", ...overrides });

describe("planBridgeSteps: input that cannot work", () => {
  it("says what is wrong with an amount that is not a number", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const attempt = () => planBridgeSteps({ values: values({ amount: "ten" }), tokens, context, delivery: null });
    expect(attempt).toThrow(PlanInputError);
    expect(attempt).toThrow('"ten" is not a decimal number');
  });

  it("does not present a decimals value that no token can have as input of the user", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const broken = tokens.map((token) => (token.address === usdc.address ? { ...token, decimals: 256 } : token));
    expect(() => planBridgeSteps({ values: values(), tokens: broken, context, delivery: null })).toThrow(RangeError);
  });

  it("asks the user to wait when no snapshot has loaded", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    expect(() => planBridgeSteps({ values: values(), tokens, context: { ...context, snapshots: null }, delivery: null })).toThrow(
      "The balances of that chain are not loaded. Check the RPC URL and wait for them.",
    );
  });

  it("asks the user to wait when the snapshot of the source chain failed", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const [, second] = context.snapshots!;
    const failed = { status: "error" as const, chain: FIXTURE_PAIR.first, message: "endpoint down" };
    expect(() => planBridgeSteps({ values: values(), tokens, context: { ...context, snapshots: [failed, second!] }, delivery: null })).toThrow(PlanInputError);
  });

  it("asks for a token when the choice names a token that the list does not hold", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    expect(() => planBridgeSteps({ values: values({ token: `first:0x${"99".repeat(20)}` }), tokens, context, delivery: null })).toThrow("Choose a token.");
  });
});
