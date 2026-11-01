import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { ChainSnapshotResult } from "@terminal/chain/live-reads";
import { GAS_RESERVE_GAS, maxSendable, nativeTokensOf, tokenBalance } from "../../src/bridge/bridge-model";

// A recorded snapshot shape: the deployer on Sepolia (1.213127 ETH, no ERC-20 positions yet).
const [eth] = nativeTokensOf(FIXTURE_PAIR);
const usdc = { address: "0x0000000000000000000000000000000000001001" as const, symbol: "USDC", decimals: 6, side: "first" as const, counterpart: null };
const snapshots: readonly ChainSnapshotResult[] = [
  {
    status: "ok",
    snapshot: {
      chain: FIXTURE_PAIR.first,
      nativeBalance: 1_213_127_000_000_000_000n,
      positions: [{ token: usdc, balance: 25_000_000n, allowance: 0n }],
    },
  },
];

describe("balances", () => {
  it("reads the native coin from the snapshot's native balance and tokens from their positions", () => {
    expect(tokenBalance(eth!, snapshots)).toBe(1_213_127_000_000_000_000n);
    expect(tokenBalance(usdc, snapshots)).toBe(25_000_000n);
    expect(tokenBalance({ ...usdc, side: "second" }, snapshots)).toBeNull();
  });

  it("keeps a gas reserve on MAX for the native coin only", () => {
    const maxFee = 2_000_000_000n; // 2 gwei
    expect(maxSendable(eth!, 1_213_127_000_000_000_000n, maxFee)).toBe(1_213_127_000_000_000_000n - GAS_RESERVE_GAS * maxFee);
    expect(maxSendable(eth!, 1_000n, maxFee)).toBe(0n);
    expect(maxSendable(usdc, 25_000_000n, maxFee)).toBe(25_000_000n);
    // Without a gas price the native MAX stays unknown rather than draining the account.
    expect(maxSendable(eth!, 1_213_127_000_000_000_000n, null)).toBeNull();
  });
});
