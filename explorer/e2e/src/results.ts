/**
 * The record of the run. Each stage appends facts (a step, a gas figure, a prove time) to `results.json` in the state
 * directory, so that the report is built from what happened and not from memory.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context.ts";

/** One fact of the run. `data` holds numbers as decimal text, because JSON has no bigint. */
export interface Fact {
  readonly stage: string;
  readonly name: string;
  readonly ok: boolean;
  readonly at: string;
  readonly data: Readonly<Record<string, string | number | boolean | null>>;
}

const fileOf = (context: Context): string => join(context.stateDirectory, "results.json");

/** All facts recorded so far. */
export const readFacts = (context: Context): readonly Fact[] => (existsSync(fileOf(context)) ? (JSON.parse(readFileSync(fileOf(context), "utf8")) as Fact[]) : []);

/** Appends a fact and prints one line. */
export const record = (context: Context, fact: Omit<Fact, "at">): void => {
  const full: Fact = { ...fact, at: new Date().toISOString() };
  writeFileSync(fileOf(context), JSON.stringify([...readFacts(context), full], null, 2));
  console.log(`${fact.ok ? "ok  " : "FAIL"} ${fact.stage}/${fact.name} ${JSON.stringify(fact.data)}`);
};
