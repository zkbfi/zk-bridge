import { describe, expect, it } from "vitest";
import { readProofRows } from "../src/archive/proof-rows.ts";
import { MODULES } from "../src/main.ts";
import { createApp } from "../src/app.ts";
import { openStorage } from "../src/storage.ts";
import { ensureProofTable } from "../src/webhook/receive.ts";
import { makeBackend, makeConfig } from "./support.ts";

const payload = `0x${"01".repeat(823)}`;

describe("the proof rows for the indexer's proof archive", () => {
  it("lists the board proof, held proofs and evidence, and leaves out a board body that is not the stored JSON", () => {
    const storage = openStorage(":memory:");
    storage.database.prepare("INSERT INTO proofs (direction, job_id, start_slot, new_slot, body, stored_at) VALUES ('first-to-second', NULL, '1', '2', ?, 5)").run(JSON.stringify({ pair: "p", payload }));
    storage.database.prepare("INSERT INTO proofs (direction, job_id, start_slot, new_slot, body, stored_at) VALUES ('second-to-first', NULL, '1', '2', 'not json', 6)").run();
    storage.database.prepare("INSERT INTO evidence (message_id, direction, body, stored_at) VALUES ('0xaa', 'first-to-second', '{}', 7)").run();
    // Without the webhook module the table of held proofs does not exist.
    expect(readProofRows(storage)).toEqual({
      board: [{ direction: "first-to-second", payload, storedAt: 5 }],
      held: [],
      evidence: [{ messageId: "0xaa", direction: "first-to-second", body: "{}", storedAt: 7 }],
    });
    storage.database.prepare("UPDATE proofs SET body = ? WHERE direction = 'second-to-first'").run(JSON.stringify({ pair: "p" }));
    ensureProofTable(storage);
    storage.database.prepare("INSERT INTO jobs (id, direction, status, created_at, updated_at) VALUES ('job-1', 'second-to-first', 'proving', 1, 1)").run();
    storage.database.prepare("INSERT INTO webhook_proofs (job_id, direction, payload, start_slot, new_slot, stored_at, posted_at, message_hash) VALUES ('job-1', 'second-to-first', ?, '3', '4', 8, 9, '0xbb')").run(payload);
    const rows = readProofRows(storage);
    expect(rows.board).toHaveLength(1);
    expect(rows.held).toEqual([{ jobId: "job-1", direction: "second-to-first", payload, storedAt: 8, postedAt: 9, messageHash: "0xbb" }]);
  });

  it("serves them at GET /archive/proofs", async () => {
    const base = makeBackend({ config: makeConfig({ indexerUrl: "http://indexer.test/" }), enabled: ["archive"] });
    const app = createApp({ context: base.context, modules: MODULES, enabled: ["archive"] });
    const answer = await app.request("/archive/proofs");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ board: [], held: [], evidence: [] });
  });
});
