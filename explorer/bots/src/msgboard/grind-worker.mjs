// Runs in a worker thread. Proof of work is a busy loop, so it must not run on the thread that serves the bots.
// Input (workerData): { url, category, payload, timeoutMilliseconds }.
// Output (one message to the parent): the reply of `runGrindJob`.
// This file only wires the thread to `runGrindJob`, which a test covers.
import { parentPort, workerData } from "node:worker_threads";
import { createClient, http } from "viem";
import { MsgBoardClient, toRLP } from "@msgboard/sdk";
import { runGrindJob } from "./grind-job.mjs";

const { url, category, payload, timeoutMilliseconds } = workerData;
const client = createClient({ transport: http(url, { timeout: timeoutMilliseconds, retryCount: 1 }) });
const board = new MsgBoardClient({ request: (argument) => client.request(argument) });
parentPort.postMessage(await runGrindJob({ category, payload }, { board, toRLP }));
