import { join } from "node:path";
import { createPublicClient, http, parseUnits, type PublicClient } from "viem";
import { minimumPriorityFeeWei, protectedAddressesOf, RATE_SCALE, type ProofDirection } from "@zk-bridge/shared";
import { BotConfigError, type TrafficConfig } from "../config/bot-config.ts";
import { createTransactionPort } from "../chain/transactions.ts";
import type { BotContext } from "../runtime/context.ts";
import { acquireLock } from "../runtime/lock-file.ts";
import { runLoop } from "../runtime/loop.ts";
import { createStateFile } from "../runtime/state-file.ts";
import { openSigner, type Signer } from "../signing/open-signer.ts";
import { createTrafficReader, type TrafficReader } from "./chain.ts";
import { boundsOf, type Random } from "./plan.ts";
import { slotDue, slotOf, type Schedule } from "./schedule.ts";
import { INITIAL_TRAFFIC_STATE, trafficStateSchema } from "./state.ts";
import { loadTestTokens } from "./tokens-file.ts";
import { createTraffic, type TrafficSide } from "./traffic.ts";

/** The directions of a pair, in the order of the configuration. */
const DIRECTIONS: readonly ProofDirection[] = ["first-to-second", "second-to-first"];

/** Replacements for the parts that touch the outside world. Tests pass fakes. */
export interface TrafficOverrides {
  readonly signer?: Signer;
  readonly publicClient?: (rpcUrl: string) => PublicClient;
  /** Replaces the reader of a chain, by chain id. */
  readonly reader?: (chainId: number, client: PublicClient) => TrafficReader;
  readonly random?: Random;
  readonly now?: () => number;
}

/** Input of {@link startTraffic}. */
export interface StartTrafficInput {
  readonly context: BotContext;
  readonly signal: AbortSignal;
  /** Send once in each enabled direction now, whatever the schedule, then return. */
  readonly runOnce: boolean;
  readonly overrides?: TrafficOverrides;
}

function requireTrafficConfig(context: BotContext): TrafficConfig {
  const traffic = context.config.traffic;
  if (traffic === undefined) throw new BotConfigError("The bot configuration has no traffic section.");
  return traffic;
}

/** The tip of the share mode, scaled by 1e18, from a percentage. @throws BotConfigError above 100 percent. */
export function tipRateOf(percentText: string): bigint {
  const rate = parseUnits(percentText, 16);
  if (rate > RATE_SCALE) throw new BotConfigError(`traffic.tipPercent ${percentText} is above 100 percent.`);
  return rate;
}

/** The gas limit that a send asks for when it deploys a copy on a chain, or null for the mediator's default. */
export function newCopyGasLimitOf(traffic: TrafficConfig, chainId: number): bigint | null {
  const text = traffic.newCopyGasLimit[String(chainId)];
  return text === undefined ? null : BigInt(text);
}

/** The schedule of a direction. */
export function scheduleOf(traffic: TrafficConfig, direction: ProofDirection): Schedule {
  return {
    intervalMilliseconds: traffic.intervalSeconds * 1000,
    offsetMilliseconds: traffic.directions[direction].offsetSeconds * 1000,
    jitterMilliseconds: traffic.jitterSeconds * 1000,
  };
}

/**
 * Starts the traffic bot: on its schedule it sends one test transfer in each enabled direction, with the dapp's default
 * tip, so the runner has something to deliver and both chains see regular traffic. It takes a lock file next to its
 * state file first, so that no second process sends from the same wallet.
 *
 * @throws LockHeldError when a live process already runs the traffic bot over the state file.
 * @throws BotConfigError when a setting is missing or the test token file does not fit the configuration.
 */
export async function startTraffic(input: StartTrafficInput): Promise<void> {
  const statePath = join(input.context.config.stateDirectory, `traffic-${input.context.pair.name}.json`);
  const lock = await acquireLock({ path: `${statePath}.lock` });
  try {
    await runTraffic(input, statePath);
  } finally {
    await lock.release();
  }
}

async function runTraffic(input: StartTrafficInput, statePath: string): Promise<void> {
  const { context, signal } = input;
  const traffic = requireTrafficConfig(context);
  const { pair, vault } = context;
  const overrides = input.overrides ?? {};
  const logger = context.logger.child({ bot: "traffic", pair: pair.name });
  const tipRate = tipRateOf(traffic.tipPercent);
  for (const side of pair.sides) {
    if (traffic.minimumNativeWei[String(side.chainId)] === undefined) {
      throw new BotConfigError(`traffic.minimumNativeWei has no entry for chain ${side.chainId} (${side.name}).`);
    }
  }
  const tokens = await loadTestTokens(traffic.tokensFile);
  for (const symbol of Object.keys(traffic.tokens)) {
    if (!tokens.some((token) => token.symbol === symbol)) throw new BotConfigError(`traffic.tokens.${symbol}: the test token file ${traffic.tokensFile} lists no token ${symbol}.`);
  }

  const signer = overrides.signer ?? (await openSigner({ settings: traffic.signer, vault, logger }));
  try {
    const makeClient = overrides.publicClient ?? ((rpcUrl: string) => createPublicClient({ transport: http(rpcUrl, { timeout: 30_000 }) }));
    const sides = pair.sides.map((side): TrafficSide => {
      const client = makeClient(side.rpcUrl);
      return {
        chainId: side.chainId,
        name: side.name,
        reader: overrides.reader?.(side.chainId, client) ?? createTrafficReader(client),
        port: createTransactionPort({
          client,
          signer,
          chainId: side.chainId,
          priorityFeeWei: traffic.priorityFeeWei === undefined ? undefined : BigInt(traffic.priorityFeeWei),
          minimumPriorityFeeWei: minimumPriorityFeeWei(side.chainId, traffic.minimumPriorityFeeWei),
          receiptTimeoutMilliseconds: traffic.receiptTimeoutSeconds * 1000,
        }),
        contracts: {
          mediator: side.contracts.mediator,
          bridge: side.contracts.bridge,
          tokenFactory: side.contracts.tokenFactory,
          wrappedNative: side.contracts.wrappedNative,
          deliveryRouter: side.contracts.deliveryRouter,
        },
        minimumNativeWei: BigInt(traffic.minimumNativeWei[String(side.chainId)] as string),
        newCopyGasLimit: newCopyGasLimitOf(traffic, side.chainId),
      };
    }) as unknown as readonly [TrafficSide, TrafficSide];
    const bounds = new Map(Object.entries(traffic.tokens).map(([symbol, settings]) => [symbol, (decimals: number) => boundsOf(settings, decimals)] as const));
    const bot = createTraffic({
      sides,
      tokens,
      bounds,
      tipRate,
      protectedAddresses: protectedAddressesOf(
        pair.sides.map((side) => ({ name: side.name, bridge: side.contracts.bridge, mediator: side.contracts.mediator, deliveryRouter: side.contracts.deliveryRouter })),
      ),
      random: overrides.random ?? Math.random,
      logger,
    });
    const state = createStateFile({ path: statePath, schema: trafficStateSchema, initial: INITIAL_TRAFFIC_STATE });
    const now = overrides.now ?? Date.now;
    const enabled = DIRECTIONS.filter((direction) => traffic.directions[direction].enabled);

    logger.info("traffic_started", {
      wallet: signer.address,
      signer: signer.kind,
      directions: enabled.map((direction) => ({ direction, offsetSeconds: traffic.directions[direction].offsetSeconds })),
      intervalSeconds: traffic.intervalSeconds,
      jitterSeconds: traffic.jitterSeconds,
      tipPercent: traffic.tipPercent,
    });
    // The runner prices a tip only in a token it has a valuation of: these are the addresses its tokenValuationsWei needs.
    logger.info("traffic_tokens", { tokens: await bot.describeTokens() });

    const attemptIn = async (direction: ProofDirection, slot: number): Promise<void> => {
      const startedAt = now();
      const record = async (): Promise<void> => {
        await state.update((current) => ({ ...current, directions: { ...current.directions, [direction]: { lastSlot: slot, lastAttemptAtMilliseconds: startedAt } } }));
      };
      const outcome = await bot.attempt({ direction, beforeFirstSend: record });
      // A skip before any transaction still uses up the slot: the next try is in the next interval.
      if (outcome.kind === "skipped") await record();
    };

    await runLoop({
      name: "traffic",
      intervalMilliseconds: traffic.pollSeconds * 1000,
      step: async () => {
        for (const direction of enabled) {
          const schedule = scheduleOf(traffic, direction);
          // One direction that fails (an endpoint that does not answer) does not hold back the other.
          try {
            if (input.runOnce) {
              await attemptIn(direction, slotOf(now(), schedule));
              continue;
            }
            const last = (await state.load()).directions[direction];
            const slot = slotDue({ direction, nowMilliseconds: now(), lastSlot: last?.lastSlot ?? null, schedule });
            if (slot !== null) await attemptIn(direction, slot);
          } catch (error) {
            logger.error("traffic_failed", { direction, error });
          }
        }
      },
      signal,
      runOnce: input.runOnce,
      logger,
    });
  } finally {
    await signer.dispose();
  }
}
