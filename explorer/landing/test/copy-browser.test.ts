// @vitest-environment jsdom
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { COPIED_TEXT, SELECTED_TEXT, browserCopyEnv, copyValue, wireCopy } from "../src/copy.ts";

beforeEach(() => {
  document.body.innerHTML = '<span class="copy-wrap"><code class="copyable" data-copy="abc">abc</code><span class="copy-status"></span></span>';
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const code = (): HTMLElement => document.querySelector(".copyable") as HTMLElement;
const status = (): HTMLElement => document.querySelector(".copy-status") as HTMLElement;

test("with the clipboard, the browser writes the value and the confirmation clears after two seconds", async () => {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void writes.push(text) } });
  vi.useFakeTimers();
  assert.equal(await copyValue(code(), browserCopyEnv()), true);
  assert.deepEqual(writes, ["abc"]);
  assert.equal(status().textContent, COPIED_TEXT);
  vi.advanceTimersByTime(1999);
  assert.equal(status().textContent, COPIED_TEXT);
  vi.advanceTimersByTime(1);
  assert.equal(status().textContent, "");
});

test("a newer message is not wiped by the timer of an older one", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => undefined } });
  vi.useFakeTimers();
  const env = browserCopyEnv();
  await copyValue(code(), env);
  status().textContent = "something else";
  vi.advanceTimersByTime(2000);
  assert.equal(status().textContent, "something else");
});

test("without a clipboard, the browser selects the text and uses the copy command", async () => {
  const execCommand = vi.fn(() => true);
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  assert.equal(await copyValue(code(), browserCopyEnv()), true);
  assert.equal(execCommand.mock.calls[0]?.[0], "copy");
  assert.equal(globalThis.getSelection()?.toString(), "abc");
  assert.equal(status().textContent, COPIED_TEXT);
});

test("a refused clipboard falls back to the selection, and a refused command asks the reader to copy", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => Promise.reject(new Error("denied")) } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
  assert.equal(await copyValue(code(), browserCopyEnv()), false);
  assert.equal(status().textContent, SELECTED_TEXT);
});

test("a copy command that throws, or a page with no selection, still ends in the ask to copy", async () => {
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: () => {
      throw new Error("not allowed");
    },
  });
  vi.spyOn(globalThis, "getSelection").mockReturnValue(null);
  assert.equal(await copyValue(code(), browserCopyEnv()), false);
  assert.equal(status().textContent, SELECTED_TEXT);
});

test("an element with no status next to it and no value still copies", async () => {
  const writes: string[] = [];
  const env = { writeText: async (text: string) => void writes.push(text), selectAndCopy: () => false, later: () => undefined };
  assert.equal(await copyValue({ dataset: {}, nextElementSibling: null }, env), true);
  assert.deepEqual(writes, [""]);
});

test("clicking something that is not a copy value, or has no closest, does nothing", () => {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void writes.push(text) } });
  wireCopy(document.body);
  document.body.click();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const text = document.createTextNode("x");
  document.body.append(text);
  text.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  text.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.deepEqual(writes, []);
});
