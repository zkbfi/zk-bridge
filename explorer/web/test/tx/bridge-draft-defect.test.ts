import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { buildDeliveryReport, buildFixtureContext } from "../helpers";

vi.mock("../../src/tx/bridge-steps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tx/bridge-steps")>()),
  planBridgeSteps: () => {
    throw new TypeError("a defect of the planner");
  },
}));

describe("computeBridgeDraft: a failure that is not a problem of the input", () => {
  it("passes on a failure of the planner that is not a PlanInputError, so that a defect is not shown as advice to the user", async () => {
    const { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS } = await import("../../src/tx/bridge-draft");
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const form = { token: `first:${FIXTURE_TOKENS[0]!.address}`, amount: "100", receiver: getAddress(`0x${"cd".repeat(20)}`), mode: "plain" as const, data: "", callGas: "", callbackGas: "" };
    const data = { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n };
    expect(() => computeBridgeDraft(form, { ...DEFAULT_DELIVERY_OPTIONS, mode: "percentage" }, data)).toThrow(TypeError);
  });
});
