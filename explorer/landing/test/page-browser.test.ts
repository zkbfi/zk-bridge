// @vitest-environment jsdom
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { startLanding } from "../src/page.ts";
import type { LandingConfig } from "../src/page.ts";
import type { ReleaseManifest } from "../src/manifest.ts";
import { makeSigner, sampleManifest } from "./helpers.ts";

const LINUX_X64 = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const gateways = ["https://{cid}.ipfs.one.example/", "https://path.example/ipfs/"];

const terminal = (platform: string, digit: string) => ({ name: "terminal", platform, file: `terminal-${platform}`, sha256: digit.repeat(64) });
const manifest: ReleaseManifest = {
  ...sampleManifest,
  downloads: [terminal("linux-x64", "a"), terminal("darwin-arm64", "b"), terminal("windows-x64", "c"), { name: "prover", platform: "linux-x64", file: "prover-linux-x64", sha256: "d".repeat(64) }],
};

async function signedFetch(listed: ReleaseManifest = manifest) {
  const signer = await makeSigner(listed);
  const files: Record<string, Uint8Array> = { m: signer.manifestBytes, s: signer.signature };
  vi.stubGlobal("fetch", async (url: string) => (url in files ? new Response(files[url] as BodyInit) : new Response("no", { status: 404 })));
  const config: LandingConfig = { title: "Releases", manifestUrl: "m", signatureUrl: "s", downloadBaseUrl: "./d", gateways, publicKeys: [signer.publicKey] };
  return config;
}

const app = (): HTMLElement => document.getElementById("app") as HTMLElement;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const program = (name: string): HTMLElement => document.querySelector(`.dl-program[data-program="${name}"]`) as HTMLElement;
const trigger = (name: string): HTMLElement => program(name).querySelector(".dl-trigger") as HTMLElement;
const items = (name: string): HTMLElement[] => [...program(name).querySelectorAll<HTMLElement>(".dl-item")];
const press = (element: Element, key: string) => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

async function shown(listed: ReleaseManifest = manifest, userAgent = LINUX_X64) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  const config = await signedFetch(listed);
  await startLanding(config);
}

/** Node 26 has its own `localStorage` global that refuses to work without a file, so the tests bring one. */
function memoryStorage(): Storage & { kept: Map<string, string> } {
  const kept = new Map<string, string>();
  return { kept, getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) } as unknown as Storage & { kept: Map<string, string> };
}
let storage = memoryStorage();
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  storage = memoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => storage });
});
afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(globalThis, "localStorage");
  else Object.defineProperty(globalThis, "localStorage", original);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("does nothing when the page has no place for it, and fetches nothing", async () => {
  document.body.innerHTML = "";
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await startLanding({ title: "T", manifestUrl: "m", signatureUrl: "s", downloadBaseUrl: "./d", gateways, publicKeys: [] });
  assert.equal(fetcher.mock.calls.length, 0);
});

test("shows the loading text first, then the verified page with the visitor's platform chosen and the release number remembered", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(LINUX_X64);
  const config = await signedFetch();
  const done = startLanding({ ...config, notice: "Test network" });
  assert.ok(app().textContent?.includes("Checking the signed release list."));
  await done;
  assert.ok(app().textContent?.includes("Test network"));
  assert.ok(app().textContent?.includes("The signature on this release list is valid."));
  const primary = program("terminal").querySelector<HTMLAnchorElement>(".dl-button");
  assert.equal(primary?.getAttribute("href"), "./d/terminal-linux-x64");
  assert.ok(primary?.textContent?.includes("Linux · x64"));
  assert.deepEqual([...storage.kept.values()], ["5"]);
});

test("shows the failure and wires nothing when the signature does not match", async () => {
  const config = await signedFetch();
  const other = await makeSigner();
  await startLanding({ ...config, publicKeys: [other.publicKey] });
  assert.ok(app().textContent?.includes("failed its check"));
  assert.equal(app().querySelector(".dl-program"), null);
  app().dispatchEvent(new MouseEvent("click", { bubbles: true }));
});

test("a browser that cannot say what it is gets the page with no platform chosen", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockImplementation(() => {
    throw new Error("no user agent");
  });
  await startLanding(await signedFetch());
  assert.equal(program("terminal").querySelector(".dl-button"), null);
  assert.ok(program("terminal").textContent?.includes("Choose your system"));
  assert.equal(trigger("terminal").getAttribute("aria-expanded"), "true");
});

test("storage that throws means the page still works and says it cannot remember", async () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => {
      throw new Error("blocked");
    },
  });
  await shown();
  assert.ok(app().textContent?.includes("cannot remember the last release number"));
});

test("a browser with no storage object at all works the same", async () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => undefined });
  await shown();
  assert.ok(app().textContent?.includes("cannot remember the last release number"));
});

test("clicking the trigger opens the menu and focuses the chosen item; clicking it again closes it and keeps focus on the trigger", async () => {
  await shown();
  assert.equal(trigger("terminal").getAttribute("aria-expanded"), "false");
  trigger("terminal").click();
  assert.equal(trigger("terminal").getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement, items("terminal").find((item) => item.getAttribute("aria-checked") === "true"));
  trigger("terminal").click();
  assert.equal(trigger("terminal").getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, trigger("terminal"));
});

test("choosing an item changes the download, closes the menu and returns focus to the trigger", async () => {
  await shown();
  trigger("terminal").click();
  items("terminal").find((item) => item.dataset.platform === "darwin-arm64")?.click();
  assert.equal(program("terminal").querySelector(".dl-button")?.getAttribute("href"), "./d/terminal-darwin-arm64");
  assert.equal(trigger("terminal").getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, trigger("terminal"));
});

test("a click elsewhere closes every open menu, also when the click lands on text", async () => {
  await shown();
  trigger("terminal").click();
  app().querySelector("h1")?.click();
  assert.equal(trigger("terminal").getAttribute("aria-expanded"), "false");
  trigger("terminal").click();
  const text = document.createTextNode("loose text");
  app().append(text);
  text.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(trigger("terminal").getAttribute("aria-expanded"), "false");
});

test("the arrow keys on the trigger open the menu; other keys on it do nothing", async () => {
  await shown();
  press(trigger("terminal"), "ArrowDown");
  assert.equal(trigger("terminal").getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement?.classList.contains("dl-item"), true);
  press(trigger("terminal"), "Escape");
  assert.equal(trigger("terminal").getAttribute("aria-expanded"), "true");
  trigger("terminal").click();
  press(trigger("terminal"), "ArrowUp");
  assert.equal(trigger("terminal").getAttribute("aria-expanded"), "true");
});

test("keys inside the open menu move, wrap, jump to the ends, close with Escape and with Tab", async () => {
  await shown();
  trigger("terminal").click();
  const list = items("terminal");
  const at = (index: number) => items("terminal")[index] as HTMLElement;
  at(0).focus();
  press(at(0), "ArrowUp");
  assert.equal(document.activeElement, list[list.length - 1]);
  press(document.activeElement as Element, "ArrowDown");
  assert.equal(document.activeElement, list[0]);
  press(list[0] as Element, "ArrowDown");
  assert.equal(document.activeElement, list[1]);
  press(list[1] as Element, "End");
  assert.equal(document.activeElement, list[list.length - 1]);
  press(list[list.length - 1] as Element, "Home");
  assert.equal(document.activeElement, list[0]);
  press(list[0] as Element, "a");
  assert.equal(trigger("terminal").getAttribute("aria-expanded"), "true");
  press(list[0] as Element, "Escape");
  assert.equal(trigger("terminal").getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, trigger("terminal"));
  trigger("terminal").click();
  press(items("terminal")[0] as Element, "Tab");
  assert.equal(trigger("terminal").getAttribute("aria-expanded"), "false");
});

test("a key pressed outside any menu is left alone", async () => {
  await shown();
  const heading = app().querySelector("h1") as HTMLElement;
  const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
  heading.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  const text = document.createTextNode("loose");
  app().append(text);
  text.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
});

test("the single-platform program has no menu, and the click on its button is not a menu click", async () => {
  await shown();
  assert.equal(trigger("prover") === null, true);
});

test("a menu for a program the list does not hold, or one that left the page, is ignored", async () => {
  await shown();
  const real = trigger("terminal");
  real.dataset.program = "ghost";
  real.click();
  assert.equal(real.getAttribute("aria-expanded"), "false");
  real.dataset.program = "";
  real.click();
  assert.equal(real.getAttribute("aria-expanded"), "false");
  const prover = program("prover");
  prover.insertAdjacentHTML("beforeend", '<button class="dl-trigger" data-program="prover" aria-expanded="false"></button>');
  (prover.querySelector(".dl-trigger") as HTMLElement).click();
  assert.equal(program("prover").querySelector(".dl-trigger"), null);
  const lost = program("terminal");
  lost.insertAdjacentHTML("beforeend", '<button class="dl-trigger" data-program="prover" aria-expanded="false"></button>');
  lost.removeAttribute("data-program");
  (lost.querySelector(".dl-trigger") as HTMLElement).click();
  const item = document.createElement("button");
  item.className = "dl-item";
  app().append(item);
  item.click();
  item.dataset.program = "ghost";
  item.click();
  press(item, "Escape");
});

test("the copy buttons of the page work after the page is wired", async () => {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void writes.push(text) } });
  await shown();
  (document.querySelector(".copyable") as HTMLElement).click();
  await settle();
  assert.equal(writes.length, 1);
  Reflect.deleteProperty(navigator, "clipboard");
});

test("a trigger or a menu that carries no program name is ignored, and a menu outside any program closes under no name", async () => {
  await shown();
  app().insertAdjacentHTML("beforeend", '<button class="dl-trigger" id="nameless"></button><ul class="dl-surface"><li><button class="dl-item" id="loose" role="menuitemradio"></button></li></ul>');
  const nameless = document.getElementById("nameless") as HTMLElement;
  nameless.click();
  press(nameless, "ArrowDown");
  press(document.getElementById("loose") as Element, "Escape");
  assert.equal(trigger("terminal").getAttribute("aria-expanded"), "false");
});

test("a click elsewhere leaves a menu that is already closed as it is, and closes only the one that is open", async () => {
  await shown({ ...manifest, downloads: [...manifest.downloads, { ...terminal("linux-x64", "e"), name: "prover2" }, { ...terminal("darwin-arm64", "f"), name: "prover2" }] });
  trigger("terminal").click();
  items("terminal")[0]?.click();
  trigger("prover2").click();
  assert.equal(trigger("prover2").getAttribute("aria-expanded"), "true");
  app().querySelector("h1")?.click();
  assert.equal(trigger("prover2").getAttribute("aria-expanded"), "false");
  assert.equal(trigger("terminal").getAttribute("aria-expanded"), "false");
});
