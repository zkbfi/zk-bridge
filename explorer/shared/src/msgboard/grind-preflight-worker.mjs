// Runs in a worker thread, the kind of thread that production grinds on. Loads the WASM engine the way a grind thread
// does (`stamperForThread`) and finds one real proof of work at a difficulty of 256 for a fixed message.
// Input (workerData): { category, data, workMultiplier, workDivisor, blockHash }.
// Output (one message to the parent): { ok: true, nonce, hash }, or { ok: false, stage: "load" | "search", error }.
import { parentPort, workerData } from "node:worker_threads";
import { stamperForThread } from "./grind-stamper.mjs";

let loadError = "the engine did not load";
const stamper = await stamperForThread(0, 1, { warn: (_event, fields) => (loadError = String(fields.reason)) });
if (stamper === undefined) {
  parentPort.postMessage({ ok: false, stage: "load", error: loadError });
} else {
  try {
    const { nonce, hash } = stamper({ ...workerData, workMultiplier: BigInt(workerData.workMultiplier), workDivisor: BigInt(workerData.workDivisor) });
    parentPort.postMessage({ ok: true, nonce: nonce.toString(), hash });
  } catch (error) {
    parentPort.postMessage({ ok: false, stage: "search", error: error instanceof Error ? error.message : String(error) });
  }
}
