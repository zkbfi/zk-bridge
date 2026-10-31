/**
 * Sets the variables that `src/lib/pair.ts` reads when a module imports it. A test that needs another pair resets
 * the modules and changes these variables first.
 */
import { fileURLToPath } from "node:url";

process.env.EXPLORER_DEPLOYMENT_FILE = fileURLToPath(new URL("./deployment-with-registry.json", import.meta.url));
process.env.EXPLORER_RPC_URL_1 = "http://127.0.0.1:1";
process.env.EXPLORER_RPC_URL_369 = "http://127.0.0.1:369";
process.env.EXPLORER_BEACON_URL_1 = "http://127.0.0.1:5052";

// Ethereum costs are priced through a PulseChain RPC; the unit tests read none (a test that wants one sets it).
const { setPulsechainAccess } = await import("../../../src/lib/transaction-costs");
setPulsechainAccess(null);
