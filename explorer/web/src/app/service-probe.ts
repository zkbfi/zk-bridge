/**
 * The live check of an outside service: the Services rows of Explore and the fields of Settings use this one probe, so
 * both screens agree on what is up. Each kind of service is asked the one question it is built to answer:
 *
 * - the indexer, the prover request endpoint, the archive and the msgboard indexer: `GET /health` (the proxy in front of
 *   them answers 404 on the bare base URL by design);
 * - an RPC: `eth_chainId` posted as JSON-RPC, and the chain must be the expected one;
 * - a beacon API (one per chain): `GET /eth/v1/beacon/genesis`, and its genesis validators root must be the chain's
 *   when the page knows it;
 * - a msgboard node (one per chain): any JSON-RPC envelope;
 * - the image server: one known token icon loads as an image.
 *
 * A probe gives up after {@link PROBE_TIMEOUT_MS}. The latency is the time of the whole check.
 */
import { GENESIS_VALIDATORS_ROOTS } from "@terminal/config/default-beacon";
import { fetchClientWithin, testBeaconGenesis, testHealthUrl, testJsonRpcUrl, testRpcChainId, type HttpClient, type TestOutcome } from "@zk-bridge/shared";

/** What to ask a service. */
export type ProbeKind =
  | { readonly kind: "health" }
  | { readonly kind: "rpc"; readonly chainId: number }
  /** A beacon API; the chain names the genesis it must serve. */
  | { readonly kind: "beacon"; readonly chainId: number }
  /** A msgboard node; the chain makes the check of one URL for two chains two checks, each with its own result. */
  | { readonly kind: "jsonrpc"; readonly chainId?: number }
  | { readonly kind: "image" };

/** The outcome of one probe. `reason` is one redacted sentence. */
export type ProbeResult = { readonly ok: true; readonly ms: number } | { readonly ok: false; readonly reason: string };

/** Checks one service URL. */
export type Prober = (url: string, kind: ProbeKind) => Promise<ProbeResult>;

/** The longest a probe waits. */
export const PROBE_TIMEOUT_MS = 8_000;

/** The token whose icon the image server check loads: WETH on Ethereum, which every image server carries. */
const PROBE_ICON = { chainId: 1, address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" } as const;

/** The icon URL that the image server check loads. */
export const probeIconUrl = (template: string): string => template.replace("{chainId}", String(PROBE_ICON.chainId)).replace("{address}", PROBE_ICON.address);

const browserLoadImage = (url: string): Promise<boolean> =>
  new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth > 0);
    image.onerror = () => resolve(false);
    image.src = url;
  });

/** What {@link createProber} can replace. Tests pass fakes. */
export type ProberOptions = {
  readonly http?: HttpClient;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly loadImage?: (url: string) => Promise<boolean>;
};

/**
 * The prober of a live page.
 *
 * @param options The HTTP client, the clock, the time limit and the image loader.
 */
export const createProber = (options: ProberOptions = {}): Prober => {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const http = options.http ?? fetchClientWithin(timeoutMs);
  const now = options.now ?? (() => performance.now());
  const loadImage = options.loadImage ?? browserLoadImage;
  const ask = async (url: string, kind: ProbeKind): Promise<TestOutcome> => {
    if (kind.kind === "health") return testHealthUrl(http, { baseUrl: url });
    if (kind.kind === "rpc") return testRpcChainId(http, { rpcUrl: url, expectedChainId: kind.chainId });
    if (kind.kind === "jsonrpc") return testJsonRpcUrl(http, { url });
    if (kind.kind === "beacon") return testBeaconGenesis(http, { beaconUrl: url, expectedGenesisValidatorsRoot: GENESIS_VALIDATORS_ROOTS[kind.chainId] ?? null });
    return (await loadImage(probeIconUrl(url))) ? { ok: "pass", message: "The icon loads." } : { ok: "fail", message: "The image server did not return an icon." };
  };
  return async (url, kind) => {
    const started = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<TestOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ ok: "fail", message: `No answer within ${Math.round(timeoutMs / 1000)} s.` }), timeoutMs);
    });
    try {
      const outcome = await Promise.race([ask(url, kind), late]);
      return outcome.ok === "pass" ? { ok: true, ms: Math.max(0, Math.round(now() - started)) } : { ok: false, reason: outcome.message };
    } finally {
      clearTimeout(timer);
    }
  };
};

/**
 * The prober of the sample page: nothing reaches a network, and every service answers at once with a made-up latency
 * that stays the same for a URL, like the rest of the sample data.
 */
export const fixtureProber: Prober = async (url) => {
  let sum = 0;
  for (const character of url) sum = (sum * 31 + character.charCodeAt(0)) % 997;
  return { ok: true, ms: 9 + (sum % 40) };
};
