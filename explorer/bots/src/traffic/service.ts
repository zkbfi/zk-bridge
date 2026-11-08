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
import { createTrafficGate, type TrafficGate } from "./gate.ts";
import { boundsOf, type Random } from "./plan.ts";
import { drawPlan, dueIndex, hourOf, unsentIn, type Cadence, type HourPlan } from "./schedule.ts";
import { INITIAL_TRAFFIC_STATE, trafficStateSchema, type TrafficDirectionState } from "./state.ts";
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
  /** Replaces the gate of a chain, by chain id. */
  readonly gate?: (chainId: number, client: PublicClient) => TrafficGate | null;
  /** Replaces the timer between two looks at a gate. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: Random;
  readonly now?: () => number;
}

/** Input of {@link startTraffic}. */
export interface StartTrafficInput {
  readonly context: BotContext;
  readonly signal: AbortSignal;
  /** Send once in each enabled direction now, whatever the plan, then return. The plan and its record stay as they were. */
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

/**
 * The beacon API whose state proofs confirm the gate of a chain: `traffic.gateBeaconUrls` of the chain, else the beacon
 * URL of the pair (`EXPLORER_BEACON_URL_<chain id>`), else null.
 */
export function gateBeaconUrlOf(traffic: TrafficConfig, side: { readonly chainId: number; readonly beaconUrl: string | null }): string | null {
  return traffic.gateBeaconUrls[String(side.chainId)] ?? side.beaconUrl;
}

/** The settings of the removed fixed interval that a configuration still names, as dotted paths. */
export function ignoredScheduleSettings(traffic: TrafficConfig): string[] {
  const named: string[] = [];
  if (traffic.intervalSeconds !== undefined) named.push("intervalSeconds");
  if (traffic.jitterSeconds !== undefined) named.push("jitterSeconds");
  for (const direction of DIRECTIONS) {
    if (traffic.directions[direction].offsetSeconds !== undefined) named.push(`directions.${direction}.offsetSeconds`);
  }
  return named;
}

/**
 * Starts the traffic bot: each hour it sends a random number of test transfers (0 to 3 by default) in each enabled direction, with the dapp's default
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
        gate:
          overrides.gate === undefined
            ? createTrafficGate({ client, gate: side.contracts.gate, chainId: side.chainId, beaconUrl: gateBeaconUrlOf(traffic, side) })
            : overrides.gate(side.chainId, client),
      };
    }) as unknown as readonly [TrafficSide, TrafficSide];
    const random = overrides.random ?? Math.random;
    const bounds = new Map(Object.entries(traffic.tokens).map(([symbol, settings]) => [symbol, (decimals: number) => boundsOf(settings, decimals)] as const));
    const bot = createTraffic({
      sides,
      tokens,
      bounds,
      tipRate,
      protectedAddresses: protectedAddressesOf(
        pair.sides.map((side) => ({ name: side.name, bridge: side.contracts.bridge, mediator: side.contracts.mediator, deliveryRouter: side.contracts.deliveryRouter })),
      ),
      random,
      logger,
      ...(overrides.sleep === undefined ? {} : { sleep: overrides.sleep }),
    });
    const state = createStateFile({ path: statePath, schema: trafficStateSchema, initial: INITIAL_TRAFFIC_STATE });
    const now = overrides.now ?? Date.now;
    const enabled = DIRECTIONS.filter((direction) => traffic.directions[direction].enabled);

    logger.info("traffic_started", {
      wallet: signer.address,
      signer: signer.kind,
      directions: enabled,
      cadence: traffic.cadence,
      tipPercent: traffic.tipPercent,
    });
    // The runner prices a tip only in a token it has a valuation of: these are the addresses its tokenValuationsWei needs.
    logger.info("traffic_tokens", { tokens: await bot.describeTokens() });

    const ignored = ignoredScheduleSettings(traffic);
    if (ignored.length > 0) logger.warn("config_ignored", { settings: ignored, reason: "the fixed interval was replaced by traffic.cadence (a random number of sends in each hour)" });

    const cadence: Cadence = traffic.cadence;
    /** Writes the state of one direction. */
    const change = async (direction: ProofDirection, mutate: (current: TrafficDirectionState) => TrafficDirectionState): Promise<void> => {
      await state.update((all) => ({ ...all, directions: { ...all.directions, [direction]: mutate(all.directions[direction] ?? { plan: null, lastAttemptAtMilliseconds: null }) } }));
    };

    /** The plan of the current hour: the stored one, or a new one that is written before anything is sent. */
    const planOf = async (direction: ProofDirection, hour: number, stored: HourPlan | null): Promise<HourPlan | null> => {
      if (stored !== null && stored.hour === hour) return stored;
      // A stored plan from the future (the clock went back) waits until its hour comes.
      if (stored !== null && stored.hour > hour) return null;
      // An hour that passed is never caught up: what it still held is dropped.
      if (stored !== null && (unsentIn(stored) > 0 || hour - stored.hour > 1)) {
        logger.warn("traffic_hour_skipped", { direction, hour: stored.hour, planned: stored.count, unsent: unsentIn(stored), hoursMissed: hour - stored.hour - 1 });
      }
      const drawn = drawPlan({ hour, cadence, random });
      await change(direction, (current) => ({ ...current, plan: drawn }));
      logger.info("traffic_hour_planned", { direction, hour, count: drawn.count, times: drawn.times.map((time) => new Date(time).toISOString()) });
      return drawn;
    };

    const attemptIn = async (direction: ProofDirection, index: number | null): Promise<void> => {
      const startedAt = now();
      const record = async (): Promise<void> => {
        await change(direction, (current) => ({
          plan: index === null || current.plan === null ? current.plan : { ...current.plan, sent: current.plan.sent.map((used, at) => used || at === index) },
          lastAttemptAtMilliseconds: startedAt,
        }));
      };
      const outcome = await bot.attempt({ direction, beforeFirstSend: record });
      // A skip before any transaction still uses up the time: the next try is at the next one.
      if (outcome.kind === "skipped") await record();
    };

    await runLoop({
      name: "traffic",
      intervalMilliseconds: traffic.pollSeconds * 1000,
      step: async () => {
        for (const direction of enabled) {
          // One direction that fails (an endpoint that does not answer) does not hold back the other.
          try {
            // --once sends now and leaves the plan alone.
            if (input.runOnce) {
              await attemptIn(direction, null);
              continue;
            }
            const current = (await state.load()).directions[direction];
            const plan = await planOf(direction, hourOf(now()), current?.plan ?? null);
            if (plan === null) continue;
            const index = dueIndex({ plan, nowMilliseconds: now(), lastAttemptAtMilliseconds: current?.lastAttemptAtMilliseconds ?? null, cadence });
            if (index !== null) await attemptIn(direction, index);
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
