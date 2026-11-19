// Types of lib.mjs for the docs package, which tests the page from TypeScript.
export type Verified = { blockscout: boolean | "unsupported" | null; sourcify: boolean | "unsupported" | null; etherscan: boolean | "unsupported" | null };
export type ContractEntry = {
  name: string;
  address: string;
  role: string;
  group: "live" | "tokens" | "third_party" | "retired";
  source: string | null;
  libraries?: string[];
  created_by?: "factory";
  source_commit: string | null;
  deployed_on: string | null;
  verified: Verified;
};
export type ChainSection = { chain_id: number; contracts: ContractEntry[]; verification_checked?: string; [field: string]: unknown };
export type DeploymentRecord = Record<string, ChainSection>;
export const ROOT: string;
export const DEPLOYMENTS: string;
export const PAGE_PATH: string;
export const VERIFIERS: readonly ("blockscout" | "sourcify" | "etherscan")[];
export const BLOCKSCOUT_API: Record<number, string>;
export const ETHERSCAN_CHAINS: Set<number>;
export function loadRecords(folder?: string): { pair: string; file: string; record: DeploymentRecord }[];
export function sectionsOf(record: DeploymentRecord): [string, ChainSection][];
export function writeRecord(file: string, record: DeploymentRecord): void;
export function addressLinks(chainId: number, address: string, verified: Verified): { kind: string; label: string; url: string }[];
export function renderPage(records: { pair: string; record: DeploymentRecord }[]): string;
export function blockscoutStatus(chainId: number, address: string, fetchImpl?: typeof fetch): Promise<boolean | "unsupported" | null>;
export function sourcifyStatus(chainId: number, address: string, fetchImpl?: typeof fetch): Promise<boolean | "unsupported" | null>;
export function etherscanStatus(chainId: number, address: string, key: string, fetchImpl?: typeof fetch): Promise<boolean | "unsupported" | null>;
export function refreshRecord(
  record: DeploymentRecord,
  options?: { fetch?: typeof fetch; etherscanKey?: string; today: string; log?: (line: string) => void },
): Promise<DeploymentRecord>;
