/**
 * The messages that the run sent, saved in the state directory so that a later stage can deliver them.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context.ts";
import type { MessageRecord } from "./delivery.ts";

const fileOf = (context: Context): string => join(context.stateDirectory, "messages.json");

/** All messages saved so far. */
export const loadMessages = (context: Context): readonly MessageRecord[] => (existsSync(fileOf(context)) ? (JSON.parse(readFileSync(fileOf(context), "utf8")) as MessageRecord[]) : []);

/** Saves a message, replacing one of the same name. */
export const saveMessage = (context: Context, message: MessageRecord): void => {
  const others = loadMessages(context).filter((candidate) => candidate.name !== message.name);
  writeFileSync(fileOf(context), JSON.stringify([...others, message], null, 2));
};
