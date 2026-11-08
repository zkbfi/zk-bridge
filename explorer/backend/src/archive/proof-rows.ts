import type { Storage } from "../storage.ts";
import { recentHandoffs } from "./handoffs.ts";

/**
 * The proofs and evidence this backend holds, for the proof archive of the explorer indexer (explorer/indexer,
 * src/proof-archive/backend-rows.ts), which reads them from `GET /archive/proofs` every few minutes. A held proof
 * (`webhook_proofs`, not yet on the board) exists only here, and the backend drops a held proof whose job ended and the
 * evidence of a delivered message, so the indexer keeps a copy of each. Owner, 2026-11-01: "seems like proofs is another
 * thing that the indexer should be caching for us".
 *
 * Everything here is public chain data or a proof of it; job ids are the backend's own names. The route is not on any
 * public host (deploy/app-server/Caddyfile), only on the loopback port that the indexer reads.
 */
export type ProofRows = {
  readonly board: Array<{ direction: string; payload: string; storedAt: number }>;
  readonly held: Array<{ jobId: string; direction: string; payload: string; storedAt: number; postedAt: number | null; messageHash: string | null }>;
  readonly evidence: Array<{ messageId: string; direction: string; body: string; storedAt: number }>;
  /** The handoff records stored since the cut-off of the call (`archive/handoffs.ts`); older ones come through the nightly snapshot. */
  readonly handoffs: Array<{ chainId: number; period: number; record: string; storedAt: number }>;
};

const tableExists = (storage: Storage, name: string): boolean =>
  storage.database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/** Reads the rows. A board row whose body is not the stored JSON is left out. */
export function readProofRows(storage: Storage, handoffsSince = 0): ProofRows {
  type Board = { direction: string; body: string; stored_at: number };
  const board = (storage.database.prepare("SELECT direction, body, stored_at FROM proofs ORDER BY direction").all() as Board[]).flatMap((row) => {
    try {
      const payload = (JSON.parse(row.body) as { payload?: unknown }).payload;
      return typeof payload === "string" ? [{ direction: row.direction, payload, storedAt: row.stored_at }] : [];
    } catch {
      return [];
    }
  });
  type Held = { job_id: string; direction: string; payload: string; stored_at: number; posted_at: number | null; message_hash: string | null };
  const held = tableExists(storage, "webhook_proofs")
    ? (storage.database.prepare("SELECT job_id, direction, payload, stored_at, posted_at, message_hash FROM webhook_proofs ORDER BY stored_at, job_id").all() as Held[]).map((row) => ({
        jobId: row.job_id,
        direction: row.direction,
        payload: row.payload,
        storedAt: row.stored_at,
        postedAt: row.posted_at,
        messageHash: row.message_hash,
      }))
    : [];
  type Evidence = { message_id: string; direction: string; body: string; stored_at: number };
  const evidence = (storage.database.prepare("SELECT message_id, direction, body, stored_at FROM evidence ORDER BY message_id").all() as Evidence[]).map((row) => ({
    messageId: row.message_id,
    direction: row.direction,
    body: row.body,
    storedAt: row.stored_at,
  }));
  return { board, held, evidence, handoffs: recentHandoffs(storage, handoffsSince) };
}
