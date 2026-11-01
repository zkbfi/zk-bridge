#!/usr/bin/env node
// Records the gate evidence of one real Sepolia epoch, for the tests: the reads of the gate, the latest block, the root of
// the beacon roots contract, the header and the state proof that the beacon node served, and the evidence that
// `ensureGateConfirmed` built from them, with the gas of `confirm` that the node estimated. Read only: it sends nothing.
//
// Keyless public endpoints only, and the file keeps their host names, never a full URL:
//   pnpm --filter @zkb/data build && node scripts/capture-gate-fixture.mjs [rpcUrl] [beaconUrl]
// Writes test/hardened/fixtures/gate_evidence_sepolia.json at the repository root.
import { writeFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { createBeaconProofSource, ensureGateConfirmed } from "../dist/index.js";

const RPC = process.argv[2] ?? "https://ethereum-sepolia-rpc.publicnode.com";
const BEACON = process.argv[3] ?? "https://lodestar-sepolia.chainsafe.io";
const GATE = "0x1782a38a37ce9fb9f53b0585b23b833847007e20";
// A sender with no code and no special rights: the estimate needs only some `from`.
const ACCOUNT = "0x000000000000000000000000000000000000dEaD";
const OUT = new URL("../../../test/hardened/fixtures/gate_evidence_sepolia.json", import.meta.url);

const json = (value) => JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner), 2);

const base = createPublicClient({ transport: http(RPC, { timeout: 30_000 }) });
const reads = {};
let block = null;
let beaconRootCall = null;
let estimatedGas = null;
const client = {
  async getBlock(args) {
    block = await base.getBlock(args);
    return block;
  },
  async readContract(args) {
    const value = await base.readContract(args);
    reads[args.functionName] = value;
    return value;
  },
  async call(args) {
    const answer = await base.call(args);
    beaconRootCall = { to: args.to, data: args.data, blockNumber: args.blockNumber, answer: answer.data };
    return answer;
  },
  async estimateGas(args) {
    estimatedGas = await base.estimateGas(args);
    return estimatedGas;
  },
};
const responses = [];
const recordingFetch = async (url, init) => {
  const response = await fetch(url, init);
  const body = await response.text();
  responses.push({ path: url.slice(BEACON.replace(/\/+$/, "").length), status: response.status, body: JSON.parse(body) });
  return new Response(body, { status: response.status, headers: { "content-type": "application/json" } });
};

for (let attempt = 0; attempt < 10; attempt += 1) {
  responses.length = 0;
  const result = await ensureGateConfirmed({ client, gate: GATE, beacon: createBeaconProofSource({ url: BEACON, fetch: recordingFetch }), account: ACCOUNT });
  if (result.kind === "wait") {
    console.log(`no header of epoch ${result.epoch} yet, waiting ${result.retryAfterSeconds} s`);
    await new Promise((resolve) => setTimeout(resolve, result.retryAfterSeconds * 1000));
    continue;
  }
  if (result.kind !== "confirm") throw new Error(`the gate needs no confirmation now (${result.kind}); capture when it does`);
  const { evidence } = result;
  const fixture = {
    note: "One real Sepolia epoch, recorded read-only by explorer/data/scripts/capture-gate-fixture.mjs. Public chain data only.",
    source: { rpcHost: new URL(RPC).host, beaconHost: new URL(BEACON).host, capturedAt: new Date().toISOString() },
    chainId: 11155111,
    gate: GATE,
    account: ACCOUNT,
    block: { number: block.number, timestamp: block.timestamp, parentBeaconBlockRoot: block.parentBeaconBlockRoot },
    reads: { ...reads, confirmedEpoch: { epoch: reads.confirmedEpoch[0], exists: reads.confirmedEpoch[1] } },
    beaconRootCall,
    beaconResponses: responses,
    estimatedGas,
    expected: {
      epoch: result.epoch,
      forkVersion: result.forkVersion,
      shape: result.shape,
      validUntil: result.validUntil,
      timestamp: evidence.timestamp,
      beaconRoot: evidence.beaconRoot,
      header: evidence.header,
      branch: evidence.evidence.branch,
      genesisValidatorsRootBranch: evidence.evidence.genesisValidatorsRootBranch,
      encoded: evidence.encoded,
      calldata: evidence.data,
    },
  };
  writeFileSync(OUT, `${json(fixture)}\n`);
  console.log(`epoch ${result.epoch}, version ${result.forkVersion}, shape ${result.shape}, confirm gas estimate ${estimatedGas}, calldata ${(evidence.data.length - 2) / 2} bytes`);
  process.exit(0);
}
throw new Error("no header of the current epoch after ten slots");
