// Runs in a worker thread. Proof of work is a busy loop, so it must not run on the thread that serves the bots.
// One of several threads that grind the same message, each over its own range of nonces; the parent takes the first answer.
// Input (workerData): { url, category, payload, timeoutMilliseconds, threadIndex, threads, deadline }.
// Output (one message to the parent): the reply of `runGrindJob`.
// This file only wires the thread to `runGrindJob`, which a test covers; grind-threads.test.ts runs it for real.
import { parentPort, workerData } from "node:worker_threads";
import { createClient, http } from "viem";
import { MsgBoardClient, toRLP } from "@msgboard/sdk";
import { runGrindJob } from "./grind-job.mjs";
import { stamperForThread } from "./grind-stamper.mjs";

const { url, category, payload, timeoutMilliseconds, threadIndex, threads, deadline } = workerData;
const client = createClient({ transport: http(url, { timeout: timeoutMilliseconds, retryCount: 1 }) });
const board = new MsgBoardClient({ request: (argument) => client.request(argument) }, { stamper: await stamperForThread(threadIndex, threads, { deadline }) });
parentPort.postMessage(await runGrindJob({ category, payload }, { board, toRLP }));
