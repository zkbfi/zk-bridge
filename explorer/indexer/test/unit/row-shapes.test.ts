import { describe, expect, it } from "vitest";
import type {
  BridgeStateRow,
  ChainTipRow,
  EscrowRow,
  FeeBalanceRow,
  GateStateRow,
  HeadUpdateRow,
  LightClientHeadRow,
  MessageRow,
  SupplyRow,
  TokenRow,
  TransferRow,
} from "@zk-bridge/shared";
import type {
  bridgedSupply,
  bridgeStates,
  chainTips,
  escrow,
  feeBalances,
  gateStates,
  headUpdates,
  lightClientHeads,
  messages,
  tokens,
  transfers,
} from "../../ponder.schema";

/**
 * The RPC data source builds rows in memory with the types of `@zk-bridge/shared`, and the indexer reads rows of its
 * tables. Both go through the same view functions, so each shared type must hold exactly the columns of its table.
 * `Same` is true only when each type is assignable to the other. A column that one side adds or drops, or retypes,
 * turns a line below into a compile error, which `pnpm typecheck` reports.
 */
type Same<left, right> = [left] extends [right] ? ([right] extends [left] ? true : false) : false;
const same = <left, right>(_proof: Same<left, right>): void => undefined;

describe("the shared row types match the tables of the indexer", () => {
  it("holds for every table that the views read", () => {
    same<MessageRow, typeof messages.$inferSelect>(true);
    same<TransferRow, typeof transfers.$inferSelect>(true);
    same<TokenRow, typeof tokens.$inferSelect>(true);
    same<EscrowRow, typeof escrow.$inferSelect>(true);
    same<SupplyRow, typeof bridgedSupply.$inferSelect>(true);
    same<FeeBalanceRow, typeof feeBalances.$inferSelect>(true);
    same<HeadUpdateRow, typeof headUpdates.$inferSelect>(true);
    same<LightClientHeadRow, typeof lightClientHeads.$inferSelect>(true);
    same<ChainTipRow, typeof chainTips.$inferSelect>(true);
    same<GateStateRow, typeof gateStates.$inferSelect>(true);
    same<BridgeStateRow, typeof bridgeStates.$inferSelect>(true);
    expect(true).toBe(true);
  });
});
