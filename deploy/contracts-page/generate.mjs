#!/usr/bin/env node
// Renders the deployed contracts page from the deployment records.
//   node deploy/contracts-page/generate.mjs             write the page from the records (no network)
//   node deploy/contracts-page/generate.mjs --refresh   first read the verification status from the explorers and write it into the records
//   node deploy/contracts-page/generate.mjs --check     exit 1 when the committed page differs from the records (no network)
// ETHERSCAN_API_KEY, when set, lets --refresh read Etherscan too. The key is never printed.
import { readFileSync, writeFileSync } from "node:fs";
import { loadRecords, PAGE_PATH, refreshRecord, renderPage, writeRecord } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((arg) => !["--refresh", "--check"].includes(arg));
if (unknown.length > 0) {
  console.error(`unknown option ${unknown.join(" ")}; the options are --refresh and --check`);
  process.exit(2);
}

const records = loadRecords();
if (args.has("--refresh")) {
  const today = new Date().toISOString().slice(0, 10);
  for (const item of records) {
    await refreshRecord(item.record, { etherscanKey: process.env.ETHERSCAN_API_KEY ?? "", today, log: (line) => console.error(line) });
    writeRecord(item.file, item.record);
    console.error(`${item.pair}: verification status written to the record`);
  }
}

const page = renderPage(records);
if (args.has("--check")) {
  let current = "";
  try {
    current = readFileSync(PAGE_PATH, "utf8");
  } catch {
    // a missing page counts as different
  }
  if (current !== page) {
    console.error("explorer/web/docs/pages/10-deployed-contracts.md is out of date: run node deploy/contracts-page/generate.mjs");
    process.exit(1);
  }
  console.error("the deployed contracts page is current");
} else {
  writeFileSync(PAGE_PATH, page);
  console.error(`wrote ${PAGE_PATH}`);
}
