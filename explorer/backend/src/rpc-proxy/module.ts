import { readFile } from "node:fs/promises";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ModuleHealth } from "../health.ts";
import type { BackendModuleContext } from "../module.ts";
import { UNKNOWN_CALLER, callerKey } from "../requests/caller.ts";
import { callerAddressOf } from "../requests/module.ts";
import { createAddressBook, deploymentChains, readIndexerTokens, type AddressBook } from "./addresses.ts";
import { handleRpc, type ProxyOutcome } from "./proxy.ts";
import { selectorsOf, type ChainRules } from "./rules.ts";

/**
 * The `rpc-proxy` module: `POST /rpc/<chainId>`, which Caddy serves as `https://rpc.zkb.fi/<chainId>` (docs/rpc-proxy.md).
 * It answers the dapp's reads through eRPC on this server, which holds the RPC key, and refuses everything else. The
 * settings are `rpcProxy` in the configuration (`settings.ts`).
 */

/** How soon a refresh runs again after a source failed, in milliseconds (the regular wait is `refreshSeconds`). */
export const RETRY_MILLISECONDS = 30_000;

/** How long a read of the indexer or of a gate may take, in milliseconds. */
const SOURCE_TIMEOUT_MILLISECONDS = 10_000;

type ProxyState = {
  book: AddressBook | null;
  readonly counts: Record<ProxyOutcome, number>;
  lastFailures: readonly string[] | null;
};

const states = new WeakMap<BackendModuleContext, ProxyState>();

function stateOf(context: BackendModuleContext): ProxyState {
  let state = states.get(context);
  if (state === undefined) {
    state = { book: null, counts: { served: 0, refused: 0, invalid: 0, "upstream-failed": 0 }, lastFailures: null };
    states.set(context, state);
  }
  return state;
}

/** The chains that the configuration serves. */
const servedChains = (context: BackendModuleContext): number[] => Object.keys(context.config.rpcProxy.chains).map(Number);

/** eRPC's address for a chain. */
const upstreamUrlOf = (context: BackendModuleContext, chainId: number): string => context.config.rpcProxy.upstreamUrl.replace("{chainId}", String(chainId));

/**
 * The visitor's address for eRPC's per-IP limits: an IPv4 address, or for IPv6 the first address of the visitor's /64
 * network (one person holds a whole /64, the same key as the backend's own limits). Null when unknown.
 */
export function visitorIpOf(request: Context, config: BackendModuleContext["config"]): string | null {
  const address = callerAddressOf(request, config);
  const key = address === undefined ? UNKNOWN_CALLER : callerKey(address);
  if (key === UNKNOWN_CALLER) return null;
  return key.endsWith("/64") ? key.slice(0, -"/64".length) : key;
}

/** Adds `POST /rpc/:chainId`. */
export function register(app: Hono, context: BackendModuleContext): void {
  const settings = context.config.rpcProxy;
  const chains = servedChains(context);
  const methods = new Set(settings.methods);
  const anyAddressSelectors = selectorsOf(settings.anyAddressFunctions);
  const multicall3 = settings.multicall3.toLowerCase();
  app.post(
    "/rpc/:chainId",
    bodyLimit({
      maxSize: settings.maxBodyBytes,
      onError: (request) => request.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `rpc.zkb.fi refused the body: it is larger than ${settings.maxBodyBytes} bytes` } }, 413),
    }),
    async (request) => {
      const text = request.req.param("chainId");
      const chainId = /^\d+$/.test(text) ? Number(text) : Number.NaN;
      if (!chains.includes(chainId)) return request.json({ error: `rpc.zkb.fi serves the chains ${chains.join(", ")}` }, 404);
      const state = stateOf(context);
      const rules: ChainRules = { chainId, methods, contracts: state.book?.contractsOf(chainId) ?? new Set(), multicall3, anyAddressSelectors };
      const { answer, outcome } = await handleRpc({
        bodyText: await request.req.text(),
        rules,
        visitorIp: visitorIpOf(request, context.config),
        upstreamUrl: upstreamUrlOf(context, chainId),
        maxBatchLength: settings.maxBatchLength,
        maxResponseBytes: settings.maxResponseBytes,
        timeoutMilliseconds: settings.timeoutSeconds * 1000,
        // Read at call time, so a test can replace it.
        fetchFunction: globalThis.fetch,
      });
      state.counts[outcome] += 1;
      if (outcome === "upstream-failed") context.logger.warn("rpc_proxy_upstream_failed", { chainId, status: answer.status });
      return request.body(answer.body, answer.status as ContentfulStatusCode, answer.headers);
    },
  );
}

/**
 * Reads the deployment files, then the gates, the fork registries and the indexer's tokens, again every
 * `refreshSeconds` (after {@link RETRY_MILLISECONDS} when a source failed). Resolves with the function that stops it.
 *
 * @throws When a deployment file cannot be read or is not JSON.
 */
export async function start(context: BackendModuleContext): Promise<() => Promise<void>> {
  const settings = context.config.rpcProxy;
  const files = settings.deploymentFiles ?? [context.config.deploymentFile];
  const deployment = (await Promise.all(files.map(async (file) => deploymentChains(JSON.parse(await readFile(file, "utf8")) as unknown)))).flat();
  const indexerUrl = context.config.indexerUrl;
  const book = createAddressBook({
    chainIds: servedChains(context),
    deployment,
    extraContracts: (chainId) => [...settings.extraContracts, ...(settings.chains[String(chainId)] as { extraContracts: string[] }).extraContracts],
    post: async (chainId, body) => {
      const response = await globalThis.fetch(upstreamUrlOf(context, chainId), { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MILLISECONDS) });
      if (response.status !== 200) throw new Error(`the node answered ${response.status}`);
      return response.json();
    },
    ...(indexerUrl === undefined ? {} : { readTokens: () => readIndexerTokens(globalThis.fetch, indexerUrl, SOURCE_TIMEOUT_MILLISECONDS) }),
  });
  const state = stateOf(context);
  state.book = book;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const refresh = async () => {
    const failures = await book.refresh();
    state.lastFailures = failures;
    if (failures.length > 0) context.logger.warn("rpc_proxy_refresh_failed", { failures });
    timer = setTimeout(() => {
      running = refresh();
    }, failures.length > 0 ? Math.min(RETRY_MILLISECONDS, settings.refreshSeconds * 1000) : settings.refreshSeconds * 1000);
    timer.unref();
  };
  running = refresh();
  await running;
  return async () => {
    clearTimeout(timer);
    await running;
    // A refresh that was running when the stop came has set its next timer by now.
    clearTimeout(timer);
  };
}

/** The counters of the module and the state of its last refresh, for `GET /health`. */
export function health(context: BackendModuleContext): ModuleHealth {
  const state = stateOf(context);
  const { served, refused, invalid } = state.counts;
  const contracts = servedChains(context)
    .map((chainId) => `${chainId}: ${state.book?.contractsOf(chainId).size ?? 0}`)
    .join(", ");
  const refresh = state.lastFailures === null ? "not yet" : state.lastFailures.length === 0 ? "ok" : `failed (${state.lastFailures.join("; ")})`;
  return {
    state: "running",
    detail: `${served} served, ${refused} refused, ${invalid} invalid, ${state.counts["upstream-failed"]} without an answer from eRPC; contracts by chain ${contracts}; last refresh ${refresh}`,
  };
}
