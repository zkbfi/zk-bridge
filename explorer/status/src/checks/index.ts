import type { Deps } from "../deps.ts";
import type { CheckDefinition, CheckSpec } from "../types.ts";
import { beaconCheck, lightClientCheck, lightClientDeadlineCheck, rpcCheck } from "./chains.ts";
import { bridgeCheck, gateCheck } from "./bridges.ts";
import { benchmarksCheck, indexerFeedCheck, pipelineCheck, gpuBillingCheck } from "./pipeline.ts";
import { runpodCheck } from "./prover.ts";
import { backendLocalCheck, backendPublicCheck, gatewayCheck, grindEngineCheck, indexerReadyCheck, siteCheck, webhookCheck } from "./services.ts";
import { unitCheck } from "./units.ts";
import { walletChecks } from "./wallets.ts";

/** Every check of this server, in the order of the page. A beacon check or a light client needs a beacon endpoint; the RunPod check needs the key. */
export function buildChecks(deps: Deps): CheckDefinition[] {
  const { services } = deps.config;
  const sides = deps.pair.sides;
  const specs: CheckSpec<Deps>[] = [
    indexerReadyCheck(services.indexerLocal, "local"),
    indexerReadyCheck(services.indexerPublic, "public"),
    backendLocalCheck(services.backendLocal),
    grindEngineCheck(services.backendLocal),
    backendPublicCheck(services.backendPublic),
    webhookCheck(services.webhookPublic),
    siteCheck("next", services.sites.next),
    siteCheck("main", services.sites.main),
    gatewayCheck("next", services.sites.next, services.gateway),
    gatewayCheck("main", services.sites.main, services.gateway),
    ...deps.config.units.map(unitCheck),
    ...sides.flatMap((side) => [rpcCheck(deps, side.chainId), ...(side.beaconUrl === null ? [] : [beaconCheck(deps, side.chainId)])]),
    lightClientCheck(deps, "first-to-second"),
    lightClientCheck(deps, "second-to-first"),
    lightClientDeadlineCheck(deps, "first-to-second"),
    lightClientDeadlineCheck(deps, "second-to-first"),
    ...sides.flatMap((side) => [bridgeCheck(deps, side.chainId), gateCheck(deps, side.chainId)]),
    benchmarksCheck(deps, services.backendLocal),
    gpuBillingCheck(services.backendLocal),
    pipelineCheck(deps, services.backendLocal, "first-to-second"),
    pipelineCheck(deps, services.backendLocal, "second-to-first"),
    indexerFeedCheck(deps, services.indexerLocal),
    ...(deps.config.runpod !== undefined && deps.apiKey !== undefined ? [runpodCheck] : []),
    ...walletChecks(deps),
  ];
  return specs.map((spec) => ({ id: spec.id, name: spec.name, section: spec.section, run: () => spec.run(deps) }));
}
