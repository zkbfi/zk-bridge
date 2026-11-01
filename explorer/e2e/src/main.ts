/**
 * The driver of the end-to-end run. `bun run src/main.ts <stage>` runs one stage on the chains that `e2e/start.sh` and
 * `e2e/deploy.sh` prepared. The stages are listed in `STAGES`.
 */
import { loadContext, type Context } from "./context.ts";
import { join } from "node:path";
import { runBots } from "./stages/bots.ts";
import { checkDashboards } from "./stages/dashboards.ts";
import { confirmGate } from "./stages/gate.ts";
import { runTraffic } from "./stages/traffic.ts";
import { deliverRound, fundSenders, sendRound, startServices } from "./stages/transfers.ts";
import { updateAndOpen } from "./stages/updates.ts";

/** The indexer of the run. Nothing listens here until the indexer stage starts it. */
const INDEXER_URL = Bun.env.E2E_INDEXER_URL ?? "http://127.0.0.1:42069";

/** Stops the indexer of the run, and waits until its port is closed. */
const stopIndexer = async (context: Context): Promise<void> => {
  const pidFile = join(context.stateDirectory, "pids", "indexer.pid");
  const pid = (await Bun.file(pidFile).text()).trim();
  await Bun.$`kill ${pid}`.quiet();
  for (let tries = 0; tries < 30; tries += 1) {
    if (!(await fetch(`${INDEXER_URL}/ready`).then((answer) => answer.ok).catch(() => false))) break;
    await new Promise((done) => setTimeout(done, 1_000));
  }
  await Bun.$`rm -f ${pidFile}`.quiet();
};

/** Starts the indexer of the run again, through the script that started it first. */
const startIndexer = async (context: Context): Promise<void> => {
  const script = join(context.repositoryRoot, "e2e/indexer.sh");
  await Bun.$`bash ${script}`.quiet();
};

const STAGES: Readonly<Record<string, (context: Context, args: readonly string[]) => Promise<void>>> = {
  open: (context) => updateAndOpen(context),
  gate: async (context) => {
    await confirmGate(context, "a", "gate");
    await confirmGate(context, "b", "gate");
  },
  fund: (context) => fundSenders(context),
  "send-a": async (context) => sendRound(context, await startServices(context, INDEXER_URL), "a"),
  "deliver-a": (context) => deliverRound(context, "a"),
  "send-b": async (context) => sendRound(context, await startServices(context, INDEXER_URL), "b"),
  "deliver-b": (context) => deliverRound(context, "b"),
  bots: (context, args) => runBots(context, { resume: args.includes("--resume") }),
  traffic: (context) => runTraffic(context),
  dashboards: (context) =>
    checkDashboards(context, {
      indexerUrl: INDEXER_URL,
      stopIndexer: () => stopIndexer(context),
      startIndexer: () => startIndexer(context),
    }),
};

const main = async (): Promise<void> => {
  const [name, ...args] = process.argv.slice(2);
  const stage = name === undefined ? undefined : STAGES[name];
  if (stage === undefined) {
    console.error(`usage: main.ts <stage>. Stages: ${Object.keys(STAGES).join(", ")}`);
    process.exit(2);
  }
  await stage(loadContext(), args);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
