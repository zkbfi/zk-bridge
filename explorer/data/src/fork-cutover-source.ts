/**
 * Reads the fork schedule and the clock of a beacon chain from its beacon node: `GET /eth/v1/config/fork_schedule`,
 * `GET /eth/v1/beacon/genesis` and `GET /eth/v1/config/spec`. The `fetch` is the caller's, so a test passes a fake and the
 * dapp, the terminal and the status service pass their own. Endpoints are tried in order; a message names no URL (a URL may
 * hold a key).
 */
import { parseBeaconGenesisTime, parseBeaconSpec, parseForkSchedule, type SourceForks } from "@zkb/core";

/** The longest that one beacon request waits, in milliseconds. */
export const FORK_SOURCE_TIMEOUT_MILLISECONDS = 10_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const getJson = async (doFetch: Fetch, base: string, path: string, timeoutMilliseconds: number): Promise<unknown> => {
  let response: Response;
  try {
    response = await doFetch(`${base}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMilliseconds) });
  } catch (error) {
    throw new Error(`no answer for ${path} (${(error as Error).name})`);
  }
  if (!response.ok) throw new Error(`answered ${response.status} for ${path}`);
  return response.json();
};

/**
 * The fork schedule and clock of a chain's beacon chain, from the first endpoint that answers all three requests.
 *
 * @param input.urls The beacon API base URLs, in order. None: unreachable.
 * @param input.fetch The `fetch` to use. Default: the global one.
 * @param input.timeoutMilliseconds The wait for one request. Default {@link FORK_SOURCE_TIMEOUT_MILLISECONDS}.
 * @returns `known`, or `unreachable` with a reason that holds no URL.
 */
export const fetchSourceForks = async (input: { readonly urls: readonly string[]; readonly fetch?: Fetch; readonly timeoutMilliseconds?: number }): Promise<SourceForks> => {
  if (input.urls.length === 0) return { kind: "unreachable", reason: "no beacon endpoint is set for this chain" };
  const doFetch: Fetch = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const timeout = input.timeoutMilliseconds ?? FORK_SOURCE_TIMEOUT_MILLISECONDS;
  let last = "";
  for (const url of input.urls) {
    const base = url.replace(/\/+$/, "");
    try {
      const [schedule, genesis, spec] = await Promise.all([
        getJson(doFetch, base, "/eth/v1/config/fork_schedule", timeout),
        getJson(doFetch, base, "/eth/v1/beacon/genesis", timeout),
        getJson(doFetch, base, "/eth/v1/config/spec", timeout),
      ]);
      return { kind: "known", forks: parseForkSchedule(schedule), clock: { genesisTime: parseBeaconGenesisTime(genesis), ...parseBeaconSpec(spec) } };
    } catch (error) {
      last = (error as Error).message;
    }
  }
  return { kind: "unreachable", reason: `${input.urls.length === 1 ? "the beacon node" : `all ${input.urls.length} beacon nodes`} did not answer (${last})` };
};
