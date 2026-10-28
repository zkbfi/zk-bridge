import assert from "node:assert/strict";
import { test } from "node:test";
import { rememberSequence } from "../src/sequence-memory.ts";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

test("accepts the first sequence and stores it", () => {
  const storage = memoryStorage();
  assert.deepEqual(rememberSequence(storage, 3), { kind: "accepted" });
  assert.deepEqual([...storage.map.values()], ["3"]);
});

test("refuses a lower sequence and names the remembered one", () => {
  const storage = memoryStorage();
  rememberSequence(storage, 7);
  assert.deepEqual(rememberSequence(storage, 6), { kind: "lower", remembered: 7 });
  assert.deepEqual([...storage.map.values()], ["7"]);
});

test("accepts an equal sequence", () => {
  const storage = memoryStorage();
  rememberSequence(storage, 7);
  assert.deepEqual(rememberSequence(storage, 7), { kind: "accepted" });
});

test("a higher sequence replaces the remembered one", () => {
  const storage = memoryStorage();
  rememberSequence(storage, 7);
  rememberSequence(storage, 9);
  assert.deepEqual([...storage.map.values()], ["9"]);
});

test("says not-remembered when storage is missing", () => {
  assert.deepEqual(rememberSequence(null, 1), { kind: "not-remembered" });
});

test("says not-remembered when storage throws, and still lets the signature check decide", () => {
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {},
  };
  assert.deepEqual(rememberSequence(throwing, 1), { kind: "not-remembered" });
  const throwingWrite = { getItem: () => null, setItem: () => { throw new Error("full"); } };
  assert.deepEqual(rememberSequence(throwingWrite, 1), { kind: "not-remembered" });
});

test("ignores a damaged remembered value", () => {
  const storage = memoryStorage();
  storage.map.set("release-sequence-highest", "junk");
  assert.deepEqual(rememberSequence(storage, 1), { kind: "accepted" });
});
