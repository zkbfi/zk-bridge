import { describe, expect, it } from "vitest";
import { FORK_PROOF_RECORD_FORMAT, checkForkProofRecord } from "../src/prover/fork-proof-record.js";
import { forkProofRecordFixture } from "./support/fork-proof-fixture.js";

const fixture = forkProofRecordFixture();
const edited = (change: Record<string, unknown>) => JSON.stringify({ ...fixture.value, ...change });

describe("checkForkProofRecord", () => {
  it("accepts a record whose branches prove its version and genesis validators root under its state root", () => {
    const answer = checkForkProofRecord(fixture.text, { chainId: 943, stateRoot: fixture.stateRoot.toUpperCase().replace("0X", "0x") });
    expect(answer).toEqual({
      ok: true,
      record: {
        text: fixture.text,
        chainId: 943,
        slot: 5678,
        blockRoot: fixture.value.blockRoot,
        stateRoot: fixture.stateRoot,
        executionBlockNumber: 1234,
        executionBlockHash: fixture.value.executionBlockHash,
        shape: 6,
      },
    });
    expect(fixture.value.format).toBe(FORK_PROOF_RECORD_FORMAT);
  });

  it("accepts the other plain depths without a state root to match", () => {
    for (const depth of [5, 7]) {
      const other = forkProofRecordFixture({ depth });
      expect(checkForkProofRecord(other.text, { chainId: 943 })).toMatchObject({ ok: true, record: { shape: depth } });
    }
  });

  it.each([
    ["{", "not JSON"],
    ["[]", "not a JSON object"],
    ["null", "not a JSON object"],
    [edited({ format: "zkb-fork-proof/2" }), "unknown format"],
    [edited({ chainId: 11155111 }), "another chain"],
    [edited({ slot: -1 }), "a number is missing"],
    [edited({ executionBlockNumber: "1" }), "a number is missing"],
    [edited({ shape: 1.5 }), "a number is missing"],
    [edited({ blockRoot: "0x12" }), "a hash is missing or not lower-case 0x hex"],
    [edited({ stateRoot: String(fixture.value.stateRoot).toUpperCase() }), "a hash is missing or not lower-case 0x hex"],
    [edited({ version: "0x1234" }), "the version is not 4 bytes of 0x hex"],
    [edited({ version: 7 }), "the version is not 4 bytes of 0x hex"],
    [edited({ versionBranch: "0x" }), "a branch is not a list of hashes"],
    [edited({ genesisValidatorsRootBranch: ["0x01"] }), "a branch is not a list of hashes"],
    [edited({ version: "0x90000076" }), "the branches do not prove it (VersionProofInvalid)"],
    [edited({ genesisValidatorsRoot: `0x${"ab".repeat(32)}` }), "the branches do not prove it (GenesisValidatorsRootProofInvalid)"],
    [edited({ versionBranch: [] }), "the branches do not prove it (ShapeNotAllowed)"],
    [edited({ shape: 5 }), "it names shape 5, the branches prove shape 6"],
  ])("refuses %s: %s", (text, reason) => {
    expect(checkForkProofRecord(text, { chainId: 943 })).toEqual({ ok: false, reason });
  });

  it("refuses a record of another state root than the one asked for", () => {
    expect(checkForkProofRecord(fixture.text, { chainId: 943, stateRoot: `0x${"cd".repeat(32)}` })).toEqual({ ok: false, reason: "another state root" });
  });
});
