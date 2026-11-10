import assert from "node:assert/strict";
import { test } from "vitest";
import { detectFromUserAgent, detectPlatform, platformLabel, platformRank } from "../src/platform.ts";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const LINUX_X64 = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const LINUX_ARM = "Mozilla/5.0 (X11; Linux aarch64; rv:130.0) Gecko/20100101 Firefox/130.0";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";

test("a user agent string picks the platform; a Mac is assumed to be Apple silicon", () => {
  assert.deepEqual(detectFromUserAgent(MAC), { key: "darwin-arm64", assumed: true });
  assert.deepEqual(detectFromUserAgent(LINUX_X64), { key: "linux-x64", assumed: false });
  assert.deepEqual(detectFromUserAgent(LINUX_ARM), { key: "linux-arm64", assumed: false });
  assert.deepEqual(detectFromUserAgent(WINDOWS), { key: "windows-x64", assumed: false });
});

test("unknown systems, a Linux without a chip, and phones have no default", () => {
  const none = { key: null, assumed: false };
  assert.deepEqual(detectFromUserAgent("Mozilla/5.0 (X11; Linux) Gecko"), none);
  assert.deepEqual(detectFromUserAgent("curl/8.0"), none);
  assert.deepEqual(detectFromUserAgent(""), none);
  assert.deepEqual(detectFromUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130 Mobile"), none);
  assert.deepEqual(detectFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari"), none);
});

function withHints(values: { architecture?: string; bitness?: string; platform?: string }, userAgent = "") {
  return { userAgent, userAgentData: { platform: values.platform, getHighEntropyValues: async () => values } };
}

test("high entropy values give a Mac its real chip, not a guess", async () => {
  assert.deepEqual(await detectPlatform(withHints({ platform: "macOS", architecture: "arm", bitness: "64" }, MAC)), { key: "darwin-arm64", assumed: false });
  assert.deepEqual(await detectPlatform(withHints({ platform: "macOS", architecture: "x86", bitness: "64" }, MAC)), { key: "darwin-x64", assumed: false });
});

test("high entropy values for Linux and Windows", async () => {
  assert.deepEqual(await detectPlatform(withHints({ platform: "Linux", architecture: "x86", bitness: "64" })), { key: "linux-x64", assumed: false });
  assert.deepEqual(await detectPlatform(withHints({ platform: "Linux", architecture: "arm", bitness: "64" })), { key: "linux-arm64", assumed: false });
  assert.deepEqual(await detectPlatform(withHints({ platform: "Windows", architecture: "x86", bitness: "64" })), { key: "windows-x64", assumed: false });
});

test("a browser without the API, or one that refuses it, falls back to the user agent", async () => {
  assert.deepEqual(await detectPlatform({ userAgent: MAC }), { key: "darwin-arm64", assumed: true });
  const refusing = { userAgent: LINUX_X64, userAgentData: { getHighEntropyValues: async () => { throw new Error("denied"); } } };
  assert.deepEqual(await detectPlatform(refusing), { key: "linux-x64", assumed: false });
  assert.deepEqual(await detectPlatform({ userAgent: "curl/8.0" }), { key: null, assumed: false });
});

test("a Mac whose hints name no chip is still assumed Apple silicon; Android gets nothing", async () => {
  assert.deepEqual(await detectPlatform(withHints({ platform: "macOS" })), { key: "darwin-arm64", assumed: true });
  assert.deepEqual(await detectPlatform(withHints({ platform: "Android", architecture: "arm" }, "Mozilla/5.0 (Linux; Android 14)")), { key: null, assumed: false });
});

test("platform labels", () => {
  assert.equal(platformLabel("darwin-arm64"), "macOS · Apple silicon");
  assert.equal(platformLabel("darwin-x64"), "macOS · Intel");
  assert.equal(platformLabel("linux-arm64"), "Linux · Arm64");
  assert.equal(platformLabel("windows-x64"), "Windows · x64");
  assert.equal(platformLabel("plan9-mips"), "plan9-mips");
});

test("a platform the hints do not name falls back to the user agent", async () => {
  assert.deepEqual(await detectPlatform(withHints({ platform: "ChromeOS", architecture: "x86", bitness: "64" }, WINDOWS)), { key: "windows-x64", assumed: false });
});

test("hints that leave out the platform use the one of the data, and missing parts count as unknown", async () => {
  const data = { userAgent: "", userAgentData: { platform: "Linux", getHighEntropyValues: async () => ({ architecture: "arm" }) } };
  assert.deepEqual(await detectPlatform(data), { key: "linux-arm64", assumed: false });
  const bare = { userAgentData: { getHighEntropyValues: async () => ({}) } };
  assert.deepEqual(await detectPlatform(bare), { key: null, assumed: false });
  assert.deepEqual(await detectPlatform({}), { key: null, assumed: false });
});

test("a 32 bit x86 Mac has no known chip, and a Linux without a chip has no default", async () => {
  assert.deepEqual(await detectPlatform(withHints({ platform: "macOS", architecture: "x86", bitness: "32" })), { key: "darwin-arm64", assumed: true });
  assert.deepEqual(await detectPlatform(withHints({ platform: "Linux", architecture: "riscv" })), { key: null, assumed: false });
});

test("the label of the any-system entry", () => {
  assert.equal(platformLabel("any"), "Any system");
  assert.equal(platformLabel("linux-x64"), "Linux · x64");
});

test("the menu lists macOS, Linux and Windows in order, and an unknown platform last", () => {
  const keys = ["windows-x64", "plan9-mips", "linux-arm64", "darwin-x64", "linux-x64", "darwin-arm64"];
  assert.deepEqual([...keys].sort((a, b) => platformRank(a) - platformRank(b)), ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64", "plan9-mips"]);
});
