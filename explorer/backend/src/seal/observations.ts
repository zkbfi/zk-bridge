/**
 * The fork observation proofs of the seal module, in `fork_observations`: one row per attempt to prove an observation for
 * a chain's `ForkRegistry`. A row starts `proving`, ends `failed` (no proof), or `proved` with the prover's package, and
 * becomes `posted` once the backend's `observe` transaction succeeded. The newest proof is served publicly
 * (`GET /fork-observations/:chainId/latest`), so anyone can post it.
 */
import type { Hex } from "viem";
import { forkObservationPackageSchema, publicForkObservation, type ForkObservationPackage, type LatestForkObservation } from "@zk-bridge/shared";
import type { Storage } from "../storage.ts";

/** Why an observation was proven: the registry held none, or the chain runs a version the registry does not name. */
export type ObservationWhy = "first" | "new-version";

type Row = { id: string; package: string | null; ended_at: number | null; posted_transaction: string | null };

/** Starts an attempt. */
export function insertObservationAttempt(storage: Storage, input: { id: string; chainId: number; version: Hex; why: ObservationWhy; at: number }): void {
  storage.database
    .prepare("INSERT INTO fork_observations (id, chain_id, version, why, status, started_at) VALUES (?, ?, ?, ?, 'proving', ?)")
    .run(input.id, input.chainId, input.version, input.why, input.at);
}

/** Ends an attempt with no proof. `error` must be safe to show: it holds no path, endpoint or prover output. */
export function failObservationAttempt(storage: Storage, input: { id: string; error: string; at: number }): void {
  storage.database.prepare("UPDATE fork_observations SET status = 'failed', error = ?, ended_at = ? WHERE id = ?").run(input.error, input.at, input.id);
}

/** Ends an attempt with its proof. */
export function storeObservationProof(storage: Storage, input: { id: string; observation: ForkObservationPackage; at: number }): void {
  storage.database.prepare("UPDATE fork_observations SET status = 'proved', package = ?, ended_at = ? WHERE id = ?").run(JSON.stringify(input.observation), input.at, input.id);
}

/** Notes the backend's `observe` transaction of a proof, once it succeeded. */
export function markObservationPosted(storage: Storage, input: { id: string; transaction: Hex }): void {
  storage.database.prepare("UPDATE fork_observations SET status = 'posted', posted_transaction = ? WHERE id = ?").run(input.transaction, input.id);
}

/**
 * The attempts for a fork version of a chain since `since`: how many, and when the newest started. They bound how often
 * the GPU is asked for the same observation.
 */
export function recentObservationAttempts(storage: Storage, input: { chainId: number; version: Hex; since: number }): { readonly count: number; readonly latestAt: number | null } {
  const row = storage.database
    .prepare("SELECT count(*) AS total, max(started_at) AS latest FROM fork_observations WHERE chain_id = ? AND version = ? AND started_at > ?")
    .get(input.chainId, input.version, input.since) as { total: number; latest: number | null };
  return { count: row.total, latestAt: row.latest };
}

/** The newest proof of a chain, with its row identifier and whether the backend posted it. Null when there is none. */
export function latestObservationProof(storage: Storage, chainId: number): { readonly id: string; readonly observation: ForkObservationPackage; readonly provedAt: number; readonly postedTransaction: Hex | null } | null {
  const row = storage.database
    .prepare("SELECT id, package, ended_at, posted_transaction FROM fork_observations WHERE chain_id = ? AND package IS NOT NULL ORDER BY ended_at DESC, rowid DESC LIMIT 1")
    .get(chainId) as Row | undefined;
  if (row === undefined) return null;
  return {
    id: row.id,
    observation: forkObservationPackageSchema.parse(JSON.parse(row.package as string)),
    provedAt: row.ended_at as number,
    postedTransaction: row.posted_transaction as Hex | null,
  };
}

/** The public view of the newest proof of a chain, or null. */
export function latestObservationView(storage: Storage, chainId: number): LatestForkObservation | null {
  const latest = latestObservationProof(storage, chainId);
  return latest === null ? null : publicForkObservation({ package: latest.observation, provedAt: latest.provedAt, postedTransaction: latest.postedTransaction });
}

/** One attempt as a step job: its chain, status and times. */
export type ObservationAttempt = { readonly id: string; readonly chainId: number; readonly status: "proving" | "proved" | "posted" | "failed"; readonly startedAt: number; readonly endedAt: number | null; readonly error: string | null };

type AttemptRow = { id: string; chain_id: number; status: ObservationAttempt["status"]; started_at: number; ended_at: number | null; error: string | null };

const toAttempt = (row: AttemptRow): ObservationAttempt => ({ id: row.id, chainId: row.chain_id, status: row.status, startedAt: row.started_at, endedAt: row.ended_at, error: row.error });

/** One attempt by id, or null. */
export function getObservationAttempt(storage: Storage, id: string): ObservationAttempt | null {
  const row = storage.database.prepare("SELECT id, chain_id, status, started_at, ended_at, error FROM fork_observations WHERE id = ?").get(id) as AttemptRow | undefined;
  return row === undefined ? null : toAttempt(row);
}

/**
 * The attempt of a chain that proves now (started after `since`, so one that a restart left behind does not count), or
 * null. A second proof of the same observation never starts while one runs: the watch waits, and a request joins it.
 */
export function provingObservation(storage: Storage, chainId: number, since: number): ObservationAttempt | null {
  const row = storage.database
    .prepare("SELECT id, chain_id, status, started_at, ended_at, error FROM fork_observations WHERE chain_id = ? AND status = 'proving' AND started_at > ? ORDER BY started_at DESC LIMIT 1")
    .get(chainId, since) as AttemptRow | undefined;
  return row === undefined ? null : toAttempt(row);
}
