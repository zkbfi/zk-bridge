/**
 * What each contract of the deployment is, by name. One map for every page (search, contract, transaction, message), so
 * a contract reads the same everywhere. The mediator moves ERC-20 tokens only (native coins go through the delivery
 * router as their wrapped token), so it is the "ERC-20 mediator", never a broad "token mediator" (owner).
 */
import type { Address } from "viem";
import type { ChainConfig, PairConfig } from "@terminal/model/types";

/** A key of the deployment's contract registry. */
export type ContractKey = keyof ChainConfig["contracts"];

/** The name of each contract of the deployment. */
export const CONTRACT_NAMES: Readonly<Record<ContractKey, string>> = {
  messageBridge: "MessageBridge",
  tokenMediator: "ERC-20 mediator",
  lightClient: "Light client",
  wrappedNative: "Wrapped native",
  gate: "Gate",
  deliveryRouter: "DeliveryRouter",
  forkRegistry: "ForkRegistry",
};

/**
 * Which contract of the deployment an address is on a chain, or null for any other address.
 *
 * @param chain The chain of the pair.
 * @param address The address.
 */
export const contractKeyOf = (chain: ChainConfig, address: string): ContractKey | null =>
  (Object.entries(chain.contracts) as [ContractKey, Address | null][]).find(([, value]) => value !== null && value.toLowerCase() === address.toLowerCase())?.[0] ?? null;

/**
 * The deployment's name for an address on a chain of the pair, or null when it is not one of the deployment's contracts
 * (or the chain is not in the pair).
 *
 * @param pair The pair.
 * @param chainId The chain the address is on.
 * @param address The address.
 */
export const contractNameOf = (pair: PairConfig, chainId: number, address: string): string | null => {
  const chain = [pair.first, pair.second].find((candidate) => candidate.chainId === chainId);
  if (chain === undefined) return null;
  const key = contractKeyOf(chain, address);
  return key === null ? null : CONTRACT_NAMES[key];
};
