import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_PAIR_NAME, loadPair, type Pair, type RegistryEnvironment } from "@zk-bridge/shared";

/**
 * Loads the pair that this indexer follows.
 *
 * Variables: `EXPLORER_PAIR` (default `eth-pls`), `EXPLORER_DEPLOYMENT_FILE` (the deployment JSON; default
 * `../deployments/<pair>.json` next to the explorer workspace), `EXPLORER_RPC_URL_<chainId>` and
 * `EXPLORER_BEACON_URL_<chainId>`. Endpoint URLs can carry keys, so they come from the environment only.
 *
 * @param environment The variables to read. Default: the process variables.
 * @param workingDirectory The directory that relative file paths resolve against. Default: the current directory.
 * @throws When the deployment file is missing or invalid, or an endpoint is missing.
 */
export const loadPairFromEnvironment = (
  environment: RegistryEnvironment = process.env,
  workingDirectory: string = process.cwd(),
): Pair => {
  const pairName = environment.EXPLORER_PAIR ?? DEFAULT_PAIR_NAME;
  const configured = environment.EXPLORER_DEPLOYMENT_FILE;
  const path = resolve(workingDirectory, configured ?? `../deployments/${pairName}.json`);
  let deployment: unknown;
  try {
    deployment = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // `readFileSync` and `JSON.parse` throw only `Error` objects.
    throw new Error(`cannot read the deployment file ${path} (set EXPLORER_DEPLOYMENT_FILE): ${(error as Error).message}`);
  }
  return loadPair({ pairName, environment, deployment });
};
