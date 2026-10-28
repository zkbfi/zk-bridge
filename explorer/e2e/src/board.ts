/**
 * A local msgboard node for the run: the board that the bots' tests use, started as its own process. It speaks the JSON-RPC
 * methods and the subscription that the bots use, and checks no proof of work. The real node (valve.city) is the same
 * protocol, with real proof of work. SYNTHETIC: only the work check is missing.
 *
 * Usage: `bun run src/board.ts <file>`. It writes its URL to the file and runs until it is stopped.
 */
import { writeFileSync } from "node:fs";
import { startFakeBoard } from "../../shared/test/support/fake-board";

const [file] = process.argv.slice(2);
if (file === undefined) {
  console.error("usage: board.ts <file that receives the URL>");
  process.exit(2);
}
const board = await startFakeBoard();
writeFileSync(file, board.url);
console.log(`board ${board.url}`);
process.on("SIGTERM", () => void board.stop().then(() => process.exit(0)));
process.on("SIGINT", () => void board.stop().then(() => process.exit(0)));
await new Promise(() => undefined);
