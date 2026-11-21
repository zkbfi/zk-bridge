import deploymentRecord from "../../../../deploy/deployments/sepolia-pls943.json";
import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { ChainSnapshotResult } from "@terminal/chain/live-reads";
import {
  FAUCET_DOCS_HREF,
  FAUCET_TOKEN_ADDRESS,
  GAS_FAUCETS,
  MINT_UNITS,
  faucetAbi,
  faucetTokensOf,
  isTestnetPair,
  mintStepOf,
  nativeBalanceOf,
} from "../../src/faucet/faucet-model";
import { TESTNET } from "./testnet-pair";
import { buildConfirmView } from "../../src/tx/confirm-model";

const record = deploymentRecord as Record<string, { chain_id: number; contracts: { name: string; address: string }[] }>;

const snapshot = (side: "first" | "second", nativeBalance: bigint): ChainSnapshotResult =>
  ({ status: "ok", snapshot: { chain: { side }, nativeBalance, positions: [] } }) as unknown as ChainSnapshotResult;

describe("the faucet token addresses", () => {
  it("are the ones the deployment record names, on both chains", () => {
    const recorded = Object.values(record).map((entry) => [entry.chain_id, entry.contracts.find((contract) => contract.name === "FaucetToken tFAU")?.address] as const);
    expect(recorded.length).toBe(2);
    for (const [chainId, address] of recorded) expect(getAddress(FAUCET_TOKEN_ADDRESS[chainId] as string)).toBe(getAddress(address as string));
  });
});

describe("isTestnetPair and faucetTokensOf", () => {
  it("know the testnet pair and no other", () => {
    expect(isTestnetPair(TESTNET)).toBe(true);
    expect(isTestnetPair(FIXTURE_PAIR)).toBe(false);
  });

  it("list one tFAU per chain of the testnet pair, and none for another pair", () => {
    const tokens = faucetTokensOf(TESTNET);
    expect(tokens.map((token) => [token.side, token.symbol, token.decimals, token.address])).toEqual([
      ["first", "tFAU", 18, FAUCET_TOKEN_ADDRESS[11155111]],
      ["second", "tFAU", 18, FAUCET_TOKEN_ADDRESS[943]],
    ]);
    expect(faucetTokensOf(FIXTURE_PAIR)).toEqual([]);
  });
});

describe("nativeBalanceOf", () => {
  it("reads the coin balance of a side, or null when that side is unread", () => {
    expect(nativeBalanceOf("first", [snapshot("first", 5n)])).toBe(5n);
    expect(nativeBalanceOf("second", [snapshot("first", 5n)])).toBeNull();
    expect(nativeBalanceOf("first", [{ status: "error" } as unknown as ChainSnapshotResult])).toBeNull();
  });
});

describe("gas faucets", () => {
  it("name the two faucets that open in a tab, with the coin each one gives", () => {
    expect(GAS_FAUCETS[11155111]).toMatchObject({ url: "https://sepolia-faucet.pk910.de/", coin: "Sepolia ETH" });
    expect(GAS_FAUCETS[943]).toMatchObject({ url: "https://faucet.v4.testnet.pulsechain.com/", coin: "testnet PLS" });
    expect(FAUCET_DOCS_HREF).toBe("#/docs/get-testnet-tokens");
  });
});

describe("mintStepOf", () => {
  it("plans mint(uint256) of 1,000 tFAU on the chain, and the confirm dialog reads it from the bytes", () => {
    const step = mintStepOf(TESTNET, 943)!;
    expect(step.plan.chain.chainId).toBe(943);
    expect(step.plan.to).toBe(FAUCET_TOKEN_ADDRESS[943]);
    expect(decodeFunctionData({ abi: faucetAbi, data: step.plan.data })).toMatchObject({ functionName: "mint", args: [MINT_UNITS] });
    const view = buildConfirmView(step);
    expect(view.blockedReason).toBeNull();
    expect(view.amountText).toBe("1000 tFAU");
    expect(view.functionSignature).toBe("mint(uint256)");
  });

  it("plans nothing for a chain that is not in the pair, or a pair that is not a testnet", () => {
    expect(mintStepOf(TESTNET, 1)).toBeNull();
    expect(mintStepOf(FIXTURE_PAIR, FIXTURE_PAIR.first.chainId)).toBeNull();
  });
});
