/**
 * The data layers of the terminal and of the web page against the running indexer, and then against none (step 5).
 *
 * Both layers are the real code: the terminal's `buildServices` and the web page's `createServices`, which share one
 * connection runtime. The checks read the feed with the indexer up, compare the statuses with what the run did, stop the
 * indexer, and read the feed again from the chains. A screenshot is not taken: the checks are programmatic.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readConfiguration, loadPairConfig, loadSharedPair } from "../../../web/src/config/environment";
import { createServices } from "../../../web/src/app/services";
import type { FeedItem } from "../../../terminal/src/model/types";
import type { Context } from "../context.ts";
import { loadMessages } from "../messages.ts";
import { record } from "../results.ts";
import { startTerminalServices, type TerminalServices } from "../terminal.ts";
import { valuationsWei } from "../tokens.ts";
import { waitUntil } from "../processes.ts";

/** A feed read from one data layer, reduced to what the checks compare. */
interface FeedReading {
  readonly label: string;
  readonly statusById: ReadonlyMap<string, string>;
  readonly hasMore: boolean;
  readonly partial: string;
}

const readFeed = async (dataSource: TerminalServices["dataSource"], label: () => string): Promise<FeedReading> => {
  const page = await dataSource.getFeed("eth-pls", {}, 200);
  const statusById = new Map<string, string>(page.items.map((item: FeedItem) => [item.id.toLowerCase(), item.status]));
  return { label: label(), statusById, hasMore: page.hasMore, partial: JSON.stringify((page as { coverage?: unknown }).coverage ?? null) };
};

/** The statuses that the run expects for every message it sent and delivered. */
const compare = (reading: FeedReading, messageIds: readonly string[]): { readonly missing: string[]; readonly wrong: string[] } => {
  const missing: string[] = [];
  const wrong: string[] = [];
  for (const id of messageIds) {
    const status = reading.statusById.get(id.toLowerCase());
    if (status === undefined) missing.push(id.slice(0, 12));
    else if (status !== "delivered") wrong.push(`${id.slice(0, 12)}=${status}`);
  }
  return { missing, wrong };
};

/** Builds the services of the web page for the run. */
const webServices = async (context: Context, indexerUrl: string) => {
  const deployment = readFileSync(join(context.stateDirectory, "deployment.json"), "utf8");
  const configuration = readConfiguration({
    VITE_EXPLORER_DATA: "live",
    VITE_EXPLORER_PAIR: "eth-pls",
    VITE_EXPLORER_INDEXER_URL: indexerUrl,
    VITE_EXPLORER_DEPLOYMENT_JSON: deployment,
    VITE_EXPLORER_RPC_URL_1: context.a.rpcUrl,
    VITE_EXPLORER_RPC_URL_369: context.b.rpcUrl,
  });
  const pair = await loadPairConfig(configuration);
  const sharedPair = await loadSharedPair(configuration);
  return createServices(configuration, pair, { sharedPair, storage: null });
};

/**
 * Runs the checks.
 *
 * @param context The run.
 * @param stopIndexer Stops the indexer. The stage calls it once the first checks are done.
 * @param startIndexer Starts it again, to check that the layers return to it.
 */
export const checkDashboards = async (context: Context, controls: { readonly indexerUrl: string; readonly stopIndexer: () => Promise<void>; readonly startIndexer: () => Promise<void> }): Promise<void> => {
  const messages = loadMessages(context);
  const ids = messages.map((message) => message.messageId);
  const problems: string[] = [];
  const terminal = await startTerminalServices(context, { indexerUrl: controls.indexerUrl, valuationsWei: await valuationsWei(context) });
  const web = await webServices(context, controls.indexerUrl);

  // 1. The indexer is up: both layers answer from it.
  const terminalWithIndexer = await readFeed(terminal.dataSource, () => terminal.dataSource.label);
  const webWithIndexer = await readFeed(web.dataSource, () => web.dataSource.label);
  for (const [name, reading] of [["terminal", terminalWithIndexer], ["web", webWithIndexer]] as const) {
    const result = compare(reading, ids);
    if (reading.label !== "indexer") problems.push(`${name} label with the indexer is ${reading.label}`);
    if (result.missing.length > 0 || result.wrong.length > 0) problems.push(`${name} feed with the indexer: missing ${result.missing.join(",")} wrong ${result.wrong.join(",")}`);
    record(context, { stage: "dashboards", name: `${name}-feed-indexer`, ok: result.missing.length === 0 && result.wrong.length === 0 && reading.label === "indexer", data: { label: reading.label, messages: ids.length, rows: reading.statusById.size, missing: result.missing.length, wrong: result.wrong.length } });
  }
  const heads = await terminal.dataSource.getHeads("eth-pls");
  const summary = await terminal.dataSource.getSummary("eth-pls");
  const oneMessage = await web.indexer.message(ids[0] as `0x${string}`);
  record(context, {
    stage: "dashboards",
    name: "heads-summary-message",
    ok: oneMessage !== null,
    data: { headsStored: heads.map((head) => String(head.storedHeadSlot)).join(","), inFlight: summary.inFlight, gateA: summary.gates.first, gateB: summary.gates.second, webMessageFound: oneMessage !== null },
  });

  // 2. The indexer stops: both layers fall back to the chains, with the right label.
  await controls.stopIndexer();
  const labelOfFallback = (reading: FeedReading) => reading.label.startsWith("RPC fallback:") && reading.label.includes("indexer unreachable");
  const terminalFallback = await waitUntil("the terminal to fall back", async () => {
    const reading = await readFeed(terminal.dataSource, () => terminal.dataSource.label);
    return labelOfFallback(reading) ? reading : undefined;
  }, 60_000);
  const webFallback = await waitUntil("the web page to fall back", async () => {
    const reading = await readFeed(web.dataSource, () => web.dataSource.label);
    return labelOfFallback(reading) ? reading : undefined;
  }, 60_000);
  for (const [name, reading] of [["terminal", terminalFallback], ["web", webFallback]] as const) {
    const result = compare(reading, ids);
    if (result.missing.length > 0 || result.wrong.length > 0) problems.push(`${name} feed from the chains: missing ${result.missing.join(",")} wrong ${result.wrong.join(",")}`);
    record(context, { stage: "dashboards", name: `${name}-feed-rpc-fallback`, ok: result.missing.length === 0 && result.wrong.length === 0, data: { label: reading.label, rows: reading.statusById.size, missing: result.missing.length, wrong: result.wrong.length, coverage: reading.partial.slice(0, 200) } });
  }
  const sourceBadge = web.connection?.source().label ?? "none";
  record(context, { stage: "dashboards", name: "web-badge-text", ok: sourceBadge.startsWith("RPC fallback:"), data: { badge: sourceBadge } });

  // 3. The indexer returns: the layers go back to it.
  await controls.startIndexer();
  const returned = await waitUntil("the layers to return to the indexer", async () => {
    await terminal.connection?.connection().checkNow();
    const reading = await readFeed(terminal.dataSource, () => terminal.dataSource.label);
    return reading.label === "indexer" ? reading : undefined;
  }, 120_000);
  record(context, { stage: "dashboards", name: "returns-to-indexer", ok: true, data: { label: returned.label, rows: returned.statusById.size } });
  if (problems.length > 0) throw new Error(problems.join("; "));
};
