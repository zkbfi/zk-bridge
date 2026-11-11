/**
 * The Forks section of Explore: per route, the next fork of the source chain with its countdown, when sends pause and
 * resume, and the head of the light client that has to follow it; per chain, the state of the deposit gate
 * (`BeaconForkGate`: mode, sealed) and what the `ForkRegistry` last observed (version, shape, slot). Anyone may press
 * "Seal the gate" when the call would succeed, and "Post the fork observation" when the backend's newest observation proof
 * would add a newer slot to the registry (each simulated first, every five minutes).
 */
import { useState } from "react";
import { getAddress } from "viem";
import type { ObservationOffer, SealOffer } from "@zk-bridge/shared";
import { planForkObservation, planGateSeal } from "@terminal/tx/gate-step";
import type { ChainConfig, PairConfig } from "@terminal/model/types";
import { TransactionDialog } from "../actions/TransactionDialog";
import { useServices } from "../app/services";
import type { WebStep } from "../tx/bridge-steps";
import { CopyValue } from "../ui/CopyValue";
import { useWallet } from "../wallet/wallet-port";
import { RouteIcons, XGroup, KV } from "../explore/parts";
import { gateLine, nextForkLine, observationLine, observeLine, pauseLine, routeStatusOf, scheduleLine } from "./fork-model";
import { useForkChainState, useForkCutover, useObservationOffer, useSealOffer } from "./use-fork";

/** One route: its status word, the next fork of the source chain, the pause, and the light client head. */
const RouteBlock = ({ source, destination, names }: { readonly source: ChainConfig; readonly destination: ChainConfig; readonly names: (chainId: number) => string }) => {
  const view = useForkCutover(source.chainId, 1_000);
  if (view === null) return null;
  const { verdict, nowSeconds } = view;
  const head = verdict.kind === "paused" ? verdict.lightClientHead : null;
  return (
    <section className="zb-xfork" data-testid={`fork-route-${source.chainId}`} data-status={routeStatusOf(verdict)}>
      <div className="zb-xrow-static">
        <RouteIcons from={source.chainId} to={destination.chainId} names={names} />
        <span className="zb-xstatus" data-status={routeStatusOf(verdict)}>
          {routeStatusOf(verdict)}
        </span>
      </div>
      <KV k={`Next fork on ${source.name}`}>
        <span data-testid="fork-next">{nextForkLine(verdict, nowSeconds)}</span>
      </KV>
      <KV k={`Sends from ${source.name}`}>
        <span data-testid="fork-pause">{pauseLine(verdict, nowSeconds, destination.name)}</span>
      </KV>
      <KV k="Fork schedule">
        <span data-testid="fork-schedule">{scheduleLine(verdict, nowSeconds)}</span>
      </KV>
      {head === null ? null : (
        <KV k={`Light client on ${destination.name}`}>
          <span>finalized head slot {head.toString()}</span>
        </KV>
      )}
    </section>
  );
};

/** One chain: its gate, its registry and the seal button. */
const ChainBlock = ({ chain }: { readonly chain: ChainConfig }) => {
  const state = useForkChainState(chain.chainId);
  const wallet = useWallet();
  const [steps, setSteps] = useState<readonly WebStep[] | null>(null);
  const gate = state?.gate ?? null;
  const offer = useSealOffer(chain.chainId, wallet.account, gate !== null && !gate.sealed);
  const registry = state?.observation?.registry ?? null;
  const observeOffer = useObservationOffer(chain.chainId, gate !== null && gate.sealed ? null : registry, wallet.account);
  if (state === undefined || (gate === null && state.observation === null)) return null;
  const observation = state.observation;
  const disclosure = { feesApplyTo: "this-transaction", deliveryCall: null, destinationNativeSymbol: null, destinationChainId: null, amountToken: null, delivery: null } as const;
  const sealStep = (ready: Extract<SealOffer, { readonly kind: "ready" }>): readonly WebStep[] => [{ plan: planGateSeal(chain, ready), disclosure }];
  const observeStep = (ready: Extract<ObservationOffer, { readonly kind: "ready" }>): readonly WebStep[] => [{ plan: planForkObservation(chain, ready), disclosure }];
  return (
    <section className="zb-xfork" data-testid={`fork-chain-${chain.chainId}`}>
      <h4 className="zb-xfork-h">{chain.name}</h4>
      {gate === null ? null : (
        <KV k="Deposit gate">
          <span data-testid="fork-gate">{gateLine(gate)}</span>
          <br />
          <CopyValue value={getAddress(gate.gate)} label={`Copy the ${chain.name} gate address`}>
            {getAddress(gate.gate)}
          </CopyValue>
        </KV>
      )}
      {observation === null ? null : (
        <KV k="Fork registry, last observed">
          <span data-testid="fork-observation">{observationLine(observation)}</span>
          <br />
          <CopyValue value={getAddress(observation.registry)} label={`Copy the ${chain.name} fork registry address`}>
            {getAddress(observation.registry)}
          </CopyValue>
        </KV>
      )}
      {gate !== null && gate.sealed ? <p className="zb-small" data-testid="fork-sealed">Sealed: the gate admits no send, and withdrawals still work.</p> : null}
      {offer !== undefined && offer.kind === "ready" ? (
        <div className="zb-xactions">
          <button type="button" className="zb-pill" data-testid="fork-seal" onClick={() => setSteps(sealStep(offer))}>
            Seal the {chain.name} gate
          </button>
          <p className="zb-small">The call simulated without a revert ({offer.via === "registry" ? "the registry shows a shape the gate does not allow" : "the beacon state has a shape the gate does not allow"}). Sealing closes the gate for good.</p>
        </div>
      ) : null}
      {observeOffer !== undefined && observeOffer.kind === "ready" ? (
        <div className="zb-xactions">
          <button type="button" className="zb-pill" data-testid="fork-observe" onClick={() => setSteps(observeStep(observeOffer))}>
            Post the fork observation
          </button>
          <p className="zb-small">{observeLine(observeOffer.observation)}</p>
        </div>
      ) : null}
      {observeOffer !== undefined && observeOffer.kind === "unavailable" ? (
        <p className="zb-small" data-testid="fork-observe-note">
          No fork observation to post: {observeOffer.reason}.
        </p>
      ) : null}
      {steps === null ? null : <TransactionDialog steps={steps} onClose={() => setSteps(null)} />}
    </section>
  );
};

/**
 * The Forks section. Nothing on the sample page (no chain is read).
 *
 * @param props The pair.
 */
export const ForkPanel = ({ pair }: { readonly pair: PairConfig }) => {
  const { connection } = useServices();
  if (connection === null) return null;
  const names = (chainId: number): string => (pair.first.chainId === chainId ? pair.first.name : pair.second.name);
  return (
    <div className="zb-col" data-testid="fork-panel">
      <XGroup title="Forks" right={<a href="#/docs/safety">How forks are handled</a>} />
      <RouteBlock source={pair.first} destination={pair.second} names={names} />
      <RouteBlock source={pair.second} destination={pair.first} names={names} />
      <ChainBlock chain={pair.first} />
      <ChainBlock chain={pair.second} />
    </div>
  );
};
