import type { Hono } from "hono";
import { PROOF_DIRECTIONS } from "@zk-bridge/shared";
import { proofArchive } from "../../proof-archive/runtime";
import { publicEvidence, publicLightClientProof, publicStorageProof } from "../../proof-archive/public";
import type { ProofArchive } from "../../proof-archive/store";

/**
 * The read routes of the proof archive (`src/proof-archive`). Everything here is public chain data, and none of it is
 * trusted: a reader verifies each answer against a header it trusts (the runner does, `proof-archive-client.ts`).
 *
 * - `GET /api/proofs/storage/:chainId/:address/:block`: the archived `eth_getProof` answers of one account in one block,
 *   as proof cache entries without the fetch time (`{ entries: [...] }`). 404 when there is none.
 * - `GET /api/proofs/light-client/:direction?startSlot=&limit=`: light client update proofs, newest start first.
 * - `GET /api/proofs/evidence/:messageId`: the delivery evidence archived for a message.
 * - `GET /api/proofs/handoffs/:chainId`: `{ periods }`, the sync-committee periods that have a handoff update, ascending.
 * - `GET /api/proofs/handoffs/:chainId/<period>.json`: the handoff update of one period, the JSON text exactly as stored
 *   (404 when none). The same layout as `handoff-updates/<chain id>/<period>.json` in the IPFS tree.
 * - `GET /api/proofs/summary`: row counts.
 *
 * 503 when the archive is off or its database cannot be reached.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MESSAGE_ID = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^\d{1,19}$/;
const MAX_INTEGER = 2_147_483_647;
const HANDOFF_FILE = /^(\d{1,10})\.json$/;

/** Registers the routes. `archive` is for a test; the default is the archive of the process. */
export const registerProofRoutes = (app: Hono, archive: () => Promise<ProofArchive | null> = () => proofArchive()): void => {
  const unavailable = { error: "the proof archive is not available" };

  app.get("/api/proofs/storage/:chainId/:address/:block", async (c) => {
    const { chainId, address, block } = c.req.param();
    if (!DECIMAL.test(chainId) || !ADDRESS.test(address) || !DECIMAL.test(block)) return c.json({ error: "expected a chain id, an address and a block number" }, 400);
    const target = await archive();
    if (target === null) return c.json(unavailable, 503);
    const entries = await target.storageProofsAt({ chainId: Number(chainId), address, blockNumber: BigInt(block) });
    if (entries.length === 0) return c.json({ error: "no archived proof for this block", entries: [] }, 404);
    return c.json({ entries: entries.map(publicStorageProof) });
  });

  app.get("/api/proofs/light-client/:direction", async (c) => {
    const direction = c.req.param("direction");
    const startSlot = c.req.query("startSlot");
    const limitText = c.req.query("limit") ?? "50";
    if (!(PROOF_DIRECTIONS as readonly string[]).includes(direction)) return c.json({ error: "unknown direction" }, 400);
    if ((startSlot !== undefined && !DECIMAL.test(startSlot)) || !DECIMAL.test(limitText) || Number(limitText) < 1 || Number(limitText) > 500) {
      return c.json({ error: "startSlot must be a slot and limit between 1 and 500" }, 400);
    }
    const target = await archive();
    if (target === null) return c.json(unavailable, 503);
    const proofs = await target.lightClientProofs({ direction, startSlot: startSlot === undefined ? undefined : BigInt(startSlot), limit: Number(limitText) });
    return c.json({ proofs: proofs.map(publicLightClientProof) });
  });

  app.get("/api/proofs/evidence/:messageId", async (c) => {
    const messageId = c.req.param("messageId");
    if (!MESSAGE_ID.test(messageId)) return c.json({ error: "the message id must be 32 bytes of 0x hex" }, 400);
    const target = await archive();
    if (target === null) return c.json(unavailable, 503);
    const evidence = await target.evidence(messageId);
    if (evidence.length === 0) return c.json({ error: "no archived evidence for this message", evidence: [] }, 404);
    return c.json({ evidence: evidence.map(publicEvidence) });
  });

  app.get("/api/proofs/handoffs/:chainId", async (c) => {
    const chainId = c.req.param("chainId");
    if (!DECIMAL.test(chainId) || Number(chainId) > MAX_INTEGER) return c.json({ error: "expected a chain id" }, 400);
    const target = await archive();
    if (target === null) return c.json(unavailable, 503);
    return c.json({ periods: await target.handoffPeriods(Number(chainId)) });
  });

  app.get("/api/proofs/handoffs/:chainId/:file", async (c) => {
    const { chainId, file } = c.req.param();
    const name = HANDOFF_FILE.exec(file);
    if (!DECIMAL.test(chainId) || Number(chainId) > MAX_INTEGER || name === null || Number(name[1]) > MAX_INTEGER) return c.json({ error: "expected a chain id and <period>.json" }, 400);
    const target = await archive();
    if (target === null) return c.json(unavailable, 503);
    const found = await target.handoff(Number(chainId), Number(name[1]));
    if (found === null) return c.json({ error: "no archived handoff update for this period" }, 404);
    return c.body(found.record, 200, { "content-type": "application/json" });
  });

  app.get("/api/proofs/summary", async (c) => {
    const target = await archive();
    if (target === null) return c.json(unavailable, 503);
    return c.json(await target.counts());
  });
};
