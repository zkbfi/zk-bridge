import assert from "node:assert/strict";
import { test } from "node:test";
import { addressLinks, blockscoutStatus, etherscanStatus, loadRecords, refreshRecord, renderPage, sectionsOf, sourcifyStatus } from "./lib.mjs";
import { constructorArgsOf, libraryFlags, selectEntries } from "./verify.mjs";

const A = "0x5897d3de91d59fb691e3887d6ffbba072384293a";
const json = (status, body) => async () => ({ status, json: async () => body });

const record = () => ({
  chain_a: {
    chain_id: 11155111,
    contracts: [
      { name: "Lib", address: "0x1111111111111111111111111111111111111111", role: "A library.", group: "live", source: "src/Lib.sol:Lib", source_commit: "abcdef12", deployed_on: "2026-11-11", verified: { blockscout: true, sourcify: true, etherscan: false } },
      { name: "Bridge", address: A, role: "The bridge.", group: "live", source: "src/Bridge.sol:Bridge", libraries: ["Lib"], source_commit: "abcdef12", deployed_on: "2026-11-11", verified: { blockscout: false, sourcify: false, etherscan: false } },
      { name: "WETH", address: "0x2222222222222222222222222222222222222222", role: "Wrapped.", group: "third_party", source: null, source_commit: null, deployed_on: null, verified: { blockscout: null, sourcify: null, etherscan: null } },
    ],
  },
  chain_b: { chain_id: 943, contracts: [{ name: "Bridge", address: A, role: "The bridge.", group: "live", source: "src/Bridge.sol:Bridge", source_commit: "abcdef12", deployed_on: "2026-11-11", verified: { blockscout: true, sourcify: "unsupported", etherscan: "unsupported" } }] },
});

test("the committed records all have a contracts list on both chains", () => {
  const records = loadRecords();
  assert.ok(records.length > 0);
  for (const { record: item } of records) assert.equal(sectionsOf(item).length, 2);
});

test("addressLinks routes PulseChain by hash and the others by path, and leaves Sourcify out where it is not supported", () => {
  const pls = addressLinks(943, A, { sourcify: "unsupported" });
  assert.deepEqual(pls.map((link) => link.url), [`https://scan.v4.testnet.pulsechain.com/#/address/${A}`]);
  const sepolia = addressLinks(11155111, A, { sourcify: true });
  assert.deepEqual(sepolia.map((link) => link.url), [`https://sepolia.etherscan.io/address/${A}`, `https://eth-sepolia.blockscout.com/address/${A}`, `https://repo.sourcify.dev/11155111/${A}`]);
});

test("the page says what each explorer shows, and not checked where nobody looked", () => {
  const page = renderPage([{ pair: "demo", record: record() }]);
  assert.match(page, /Etherscan\]\(https:\/\/sepolia\.etherscan\.io\/address\/0x5897[0-9a-f]+\): not verified/);
  assert.match(page, /Sourcify: not supported/);
  assert.match(page, /\| WETH \|.*not ours.*not recorded/);
  assert.match(page, /Third-party contracts on Sepolia/);
});

test("refreshRecord writes the status it read, keeps what an explorer did not answer, and never logs the key", async () => {
  const lines = [];
  const key = "SECRETKEY123";
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes("blockscout.com")) return { status: 200, json: async () => ({ is_verified: true }) };
    if (url.includes("sourcify.dev")) return { status: 404, json: async () => ({}) };
    return { status: 200, json: async () => ({ result: [{ SourceCode: "" }] }) };
  };
  const item = record();
  await refreshRecord(item, { fetch: fetchImpl, etherscanKey: key, today: "2026-12-01", log: (line) => lines.push(line) });
  assert.deepEqual(item.chain_a.contracts[1].verified, { blockscout: true, sourcify: false, etherscan: false });
  assert.equal(item.chain_a.verification_checked, "2026-12-01");
  assert.equal(item.chain_b.contracts[0].verified.sourcify, false, "a 404 from Sourcify means not verified (it does serve the chain id in this stub)");
  assert.equal(item.chain_b.contracts[0].verified.etherscan, "unsupported");
  assert.ok(!lines.join("\n").includes(key));
});

test("a status that no explorer gave stays as it was", async () => {
  const item = record();
  const failing = async () => ({ status: 200, json: async () => ({}) });
  const status = await etherscanStatus(11155111, A, "k", async () => ({ status: 200, json: async () => ({ result: "Invalid API Key" }) }));
  assert.equal(status, null);
  assert.equal(await etherscanStatus(11155111, A, "", failing), null);
  assert.equal(await etherscanStatus(943, A, "k", failing), "unsupported");
  assert.equal(await blockscoutStatus(1, A, failing), "unsupported");
  assert.equal(await blockscoutStatus(943, A, json(404, null)), false);
  assert.equal(await sourcifyStatus(943, A, json(400, { customCode: "unsupported_chain" })), "unsupported");
  assert.equal(await sourcifyStatus(11155111, A, json(200, { match: "exact_match" })), true);
  assert.equal(item.chain_a.contracts[1].verified.blockscout, false);
});

test("verify picks the contracts of one source commit and links libraries from the same chain", () => {
  const item = record();
  assert.equal(selectEntries(item, { commit: "abcdef1234567890" }).length, 3, "Lib and the Bridge of each chain; the third-party one has no source");
  assert.equal(selectEntries(item, { commit: "abcdef12", chain: 943 }).length, 1);
  assert.equal(selectEntries(item, { commit: "abcdef12", only: ["Lib"] }).length, 1);
  assert.equal(selectEntries(item, { commit: "99999999" }).length, 0);
  assert.deepEqual(libraryFlags(item.chain_a, item.chain_a.contracts[1]), ["--libraries", "src/Lib.sol:Lib:0x1111111111111111111111111111111111111111"]);
  assert.throws(() => libraryFlags(item.chain_a, { name: "X", libraries: ["Nope"] }), /not in the record/);
});

test("constructor arguments are what follows the creation code", () => {
  const word = "00".repeat(31) + "07";
  assert.equal(constructorArgsOf(`0x6080${word}`, "0x6080"), word);
  assert.equal(constructorArgsOf("0x6080", "0x6080"), "");
  assert.throws(() => constructorArgsOf("0x60", "0x6080"), /shorter/);
  assert.throws(() => constructorArgsOf("0x608001", "0x6080"), /whole number/);
});
