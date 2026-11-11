/**
 * The proof archive: a Postgres schema of its own, `proof_archive`, next to the versioned schemas of Ponder.
 *
 * Owner, 2026-11-01: "seems like proofs is another thing that the indexer should be caching for us. we also need to write
 * playbooks / scripts to help move import/export these proofs into and out of db's. otherwise we will lose them and they
 * seem incredibly difficult to recompute". And earlier: "and if the proofs get harder to compute the further back one has
 * to go simply based on the rpc recomputing it, then we should also be caching the proofs right? as in, starting now".
 *
 * Each indexer build gets a new Ponder schema (`DATABASE_SCHEMA=indexer_<hash>`, deploy/app-server/deploy.sh), and an old
 * one is dropped in time, so nothing durable may live there. This schema is created here, outside Ponder, and no release
 * drops it. Rows are keyed by what they prove (natural keys), written by upsert and never deleted. A second value for a
 * key never replaces the first: it goes to `conflicts`. See docs/proof-archive.md.
 */

/** The name of the schema. */
export const PROOF_ARCHIVE_SCHEMA = "proof_archive";

/** The version that {@link MIGRATION} brings the schema to. */
export const PROOF_ARCHIVE_VERSION = 3;

/**
 * The migration, as one script: one transaction under an advisory lock, so two indexers that start at once (the blue
 * and green ones of a release switch) do not race on `CREATE ... IF NOT EXISTS`. Running it again changes nothing.
 */
export const MIGRATION = `
BEGIN;
SELECT pg_advisory_xact_lock(7340117);
CREATE SCHEMA IF NOT EXISTS proof_archive;
CREATE TABLE IF NOT EXISTS proof_archive.schema_version (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
-- eth_getProof answers, as the node sent them, for one account and its storage keys in one block.
CREATE TABLE IF NOT EXISTS proof_archive.storage_proofs (
  chain_id integer NOT NULL,
  address text NOT NULL CHECK (address = lower(address)),
  block_number bigint NOT NULL,
  block_hash text NOT NULL CHECK (block_hash = lower(block_hash)),
  storage_keys text[] NOT NULL,
  stored_slot bigint NOT NULL,
  proof jsonb NOT NULL,
  fetched_at text NOT NULL,
  source_host text,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, address, block_number, block_hash, storage_keys)
);
-- SP1 light client update proofs: one row per distinct proof of one direction from one head to the next.
CREATE TABLE IF NOT EXISTS proof_archive.light_client_proofs (
  pair text NOT NULL,
  direction text NOT NULL,
  start_slot bigint NOT NULL,
  new_slot bigint NOT NULL,
  proof_hash text NOT NULL,
  proof text NOT NULL,
  public_values text NOT NULL,
  start_root text NOT NULL,
  new_root text NOT NULL,
  execution_block_hash text NOT NULL,
  execution_block_number bigint NOT NULL,
  program_key text,
  payload text,
  posted_chain_id integer,
  posted_transaction_hash text,
  posted_block_number bigint,
  board_message_hash text,
  backend_job_id text,
  source text NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pair, direction, start_slot, new_slot, proof_hash)
);
CREATE INDEX IF NOT EXISTS light_client_proofs_by_start ON proof_archive.light_client_proofs (pair, direction, start_slot);
-- Delivery evidence of messages, exactly as the backend stored it. The backend drops it once a message is delivered.
CREATE TABLE IF NOT EXISTS proof_archive.message_evidence (
  message_id text NOT NULL CHECK (message_id = lower(message_id)),
  body_hash text NOT NULL,
  pair text NOT NULL,
  direction text NOT NULL,
  body text NOT NULL,
  stored_at bigint,
  source text NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, body_hash)
);
-- A value that differed from the archived one for the same key. The archived one stays.
CREATE TABLE IF NOT EXISTS proof_archive.conflicts (
  id bigserial PRIMARY KEY,
  table_name text NOT NULL,
  row_key jsonb NOT NULL,
  column_name text NOT NULL,
  existing_value text,
  incoming_value text,
  source text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now()
);
-- One report per distinct incoming value. A digest, because a whole proof is over the size of an index row.
CREATE UNIQUE INDEX IF NOT EXISTS conflicts_once ON proof_archive.conflicts (table_name, md5(row_key::text), column_name, md5(coalesce(incoming_value, '')));
INSERT INTO proof_archive.schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;
-- Version 2: the handoff update of each sync-committee period of a source chain (a light client strands for good when no
-- source has the update of a missed period). The text is kept exactly as the backend stored it, so the bytes and hash hold.
CREATE TABLE IF NOT EXISTS proof_archive.handoff_updates (
  chain_id integer NOT NULL,
  period integer NOT NULL,
  record text NOT NULL,
  sha256 text NOT NULL,
  attested_slot bigint NOT NULL,
  finalized_slot bigint NOT NULL,
  stored_at bigint,
  source text NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, period)
);
INSERT INTO proof_archive.schema_version (version) VALUES (2) ON CONFLICT DO NOTHING;
-- Version 3: the fork proof of each source beacon block that carries a message (the fork version and the genesis validators
-- root under the state root of the block). PulseChain nodes prune old states, so the proof cannot be made again later.
-- Several messages of one block share one row. The text is kept exactly as the backend stored it, so the bytes and hash hold.
CREATE TABLE IF NOT EXISTS proof_archive.fork_proofs (
  chain_id integer NOT NULL,
  state_root text NOT NULL CHECK (state_root = lower(state_root)),
  slot bigint NOT NULL,
  block_root text NOT NULL,
  execution_block_number bigint NOT NULL,
  execution_block_hash text NOT NULL,
  shape integer NOT NULL,
  record text NOT NULL,
  sha256 text NOT NULL,
  stored_at bigint,
  source text NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, state_root)
);
CREATE INDEX IF NOT EXISTS fork_proofs_by_slot ON proof_archive.fork_proofs (chain_id, slot);
INSERT INTO proof_archive.schema_version (version) VALUES (3) ON CONFLICT DO NOTHING;
COMMIT;
`;
