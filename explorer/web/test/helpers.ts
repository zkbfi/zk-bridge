/**
 * Shared builders for the tests. Each one states what it stands for, so a test reads as a story.
 */
import { parseDeliveryCostReport, type DeliveryCostReport } from "@zk-bridge/shared";
import { FIXTURE_NOW } from "@terminal/data/fixtures";

/** Options of {@link buildDeliveryReport}. */
export type DeliveryReportOptions = {
  /** Deliveries that the report claims to have measured for the callback kind. Zero gives the default. Default: 40. */
  readonly sampleCount?: number;
  /** The base fee in wei per gas. Default: 7 gwei. */
  readonly baseFeeWei?: bigint;
  /** The proof share in wei. Null means the indexer has no coin price. Default: 8 trillion wei. */
  readonly proofCostWei?: bigint | null;
  /** The measured p90 gas of the callback kind. Default: 210000. */
  readonly p90Gas?: bigint;
  /** The default gas of the callback kind. Default: 300000. */
  readonly defaultGas?: bigint;
};

/**
 * A report in the shape of `GET /api/delivery-cost`, checked by the real parser.
 *
 * @param chainId The destination chain.
 * @param options What the report holds.
 */
export const buildDeliveryReport = (chainId: number, options: DeliveryReportOptions = {}): DeliveryCostReport => {
  const sampleCount = options.sampleCount ?? 40;
  const measured = sampleCount > 0;
  const proofCostWei = options.proofCostWei === undefined ? 8_000_000_000_000n : options.proofCostWei;
  return parseDeliveryCostReport({
    chainId,
    baseFee: { wei: (options.baseFeeWei ?? 7_000_000_000n).toString(), blockNumber: 21_000_000, timestamp: FIXTURE_NOW - 12 },
    proofCost: {
      usd: "0.02",
      nativeCoinPriceUsd: proofCostWei === null ? null : "2500",
      deliveriesPerProof: 1,
      wei: proofCostWei === null ? null : proofCostWei.toString(),
      isEstimate: true,
    },
    kinds: {
      token_callback: {
        sampleCount,
        averageGas: measured ? "185000" : null,
        p90Gas: measured ? (options.p90Gas ?? 210_000n).toString() : null,
        defaultGas: (options.defaultGas ?? 300_000n).toString(),
        isDefault: !measured,
      },
      token: { sampleCount: 0, averageGas: null, p90Gas: null, defaultGas: "250000", isDefault: true },
      message: { sampleCount: 0, averageGas: null, p90Gas: null, defaultGas: "200000", isDefault: true },
    },
  });
};

import type { BridgeContext } from "@terminal/app/actions";
import { createFixtureChainAccess } from "@terminal/chain/fixture-chain-access";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";

/** Numbers of the fixture chains. */
export type FixtureContextOptions = {
  /** The allowance that the account gave the mediator. Default: zero, so a relay needs an approval first. */
  readonly allowance?: bigint;
  /** The fee rate of both mediators, scaled by 1e18. Default: 0.1 percent. */
  readonly feeRate?: bigint;
};

/**
 * The live state of the fixture pair for the fixture account: balances, allowances and fee rates of both chains.
 *
 * @param options The numbers of the fixture chains.
 */
export const buildFixtureContext = async (options: FixtureContextOptions = {}): Promise<{ readonly context: BridgeContext; readonly tokens: typeof FIXTURE_TOKENS }> => {
  const access = createFixtureChainAccess(FIXTURE_PAIR, { ...(options.allowance === undefined ? {} : { allowance: options.allowance }), ...(options.feeRate === undefined ? {} : { feeRate: options.feeRate }) });
  const snapshots = await access.readSnapshots({ account: FIXTURE_ACCOUNT, tokens: FIXTURE_TOKENS });
  return { context: { pair: FIXTURE_PAIR, snapshots, signerAddress: FIXTURE_ACCOUNT }, tokens: FIXTURE_TOKENS };
};
