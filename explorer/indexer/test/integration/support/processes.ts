import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** The indexer package directory. */
export const INDEXER_DIRECTORY = resolve(here, "..", "..", "..");
/** The repository root. */
export const REPOSITORY_ROOT = resolve(INDEXER_DIRECTORY, "..", "..");

/** Something that must be stopped at the end of a test run. */
export type Stoppable = { readonly stop: () => Promise<void> };

/** Finds a free TCP port on the loopback interface. */
export const freePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });

/**
 * Polls until a check gives a value that is not undefined.
 *
 * @param description What the test waits for, for the error message.
 * @param check The check. Return undefined to keep waiting. A thrown error also keeps waiting.
 * @param timeoutMilliseconds The longest wait.
 */
export const waitFor = async <value>(
  description: string,
  check: () => Promise<value | undefined>,
  timeoutMilliseconds = 45_000,
  failFast: () => Error | undefined = () => undefined,
): Promise<value> => {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const fatal = failFast();
    if (fatal !== undefined) throw fatal;
    try {
      const result = await check();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, 400));
  }
  throw new Error(`timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
};

const stopProcess = (child: ChildProcess): Promise<void> =>
  new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once("exit", () => done());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 8_000).unref();
  });

/** A local Anvil chain. */
export type AnvilChain = Stoppable & { readonly url: string; readonly chainId: number };

/**
 * Starts an Anvil chain on a free port.
 *
 * @param chainId The chain identifier.
 * @param hardfork The hardfork name.
 * @param options `blockTimeSeconds` makes the node mine on a timer. Without it the node mines one block per transaction.
 */
export const startAnvil = async (
  chainId: number,
  hardfork: string,
  options: { readonly blockTimeSeconds?: number } = {},
): Promise<AnvilChain> => {
  const port = await freePort();
  const blockTime = options.blockTimeSeconds === undefined ? [] : ["--block-time", String(options.blockTimeSeconds)];
  const child = spawn("anvil", ["--port", String(port), "--chain-id", String(chainId), "--hardfork", hardfork, "--silent", ...blockTime], {
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(`anvil ${chainId}`, async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return response.ok ? true : undefined;
  });
  return { url, chainId, stop: () => stopProcess(child) };
};

/** A throwaway Postgres server. */
export type TemporaryPostgres = Stoppable & { readonly connectionString: string };

/** Starts a Postgres server in a temporary directory, with no password, on the loopback interface. */
export const startPostgres = async (): Promise<TemporaryPostgres> => {
  const directory = mkdtempSync(join(tmpdir(), "explorer-postgres-"));
  const data = join(directory, "data");
  const socketDirectory = join(directory, "socket");
  mkdirSync(socketDirectory);
  const port = await freePort();
  execFileSync("initdb", ["-D", data, "-A", "trust", "-U", "explorer", "--no-sync"], { stdio: "ignore" });
  execFileSync("pg_ctl", ["-D", data, "-w", "-o", `-p ${port} -k ${socketDirectory} -c listen_addresses=127.0.0.1 -c fsync=off`, "start"], {
    stdio: "ignore",
  });
  execFileSync("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "explorer", "explorer"], { stdio: "ignore" });
  return {
    connectionString: `postgres://explorer@127.0.0.1:${port}/explorer`,
    stop: async () => {
      execFileSync("pg_ctl", ["-D", data, "-m", "immediate", "stop"], { stdio: "ignore" });
      rmSync(directory, { recursive: true, force: true });
    },
  };
};

/** A running Ponder indexer. */
export type RunningIndexer = Stoppable & { readonly apiUrl: string; readonly logFile: string };

/** The inputs of `startIndexer`. */
export type StartIndexerInput = {
  readonly environment: Record<string, string>;
  readonly databaseUrl: string;
  readonly schema: string;
};

/**
 * Starts `ponder start` in the indexer directory and waits until the API answers `/ready`.
 *
 * @param input The environment variables of the indexer, the database and the schema name.
 */
export const startIndexer = async (input: StartIndexerInput): Promise<RunningIndexer> => {
  const port = await freePort();
  const logDirectory = mkdtempSync(join(tmpdir(), "explorer-ponder-log-"));
  const logFile = join(logDirectory, "ponder.log");
  const logDescriptor = openSync(logFile, "w");
  const child = spawn(
    join(INDEXER_DIRECTORY, "node_modules", ".bin", "ponder"),
    ["start", "--port", String(port), "--schema", input.schema],
    {
      cwd: INDEXER_DIRECTORY,
      env: { ...process.env, ...input.environment, DATABASE_URL: input.databaseUrl, NO_COLOR: "1" },
      stdio: ["ignore", logDescriptor, logDescriptor],
    },
  );
  closeSync(logDescriptor);
  const apiUrl = `http://127.0.0.1:${port}`;
  await waitFor(
    "the indexer to be ready",
    async () => {
      const response = await fetch(`${apiUrl}/ready`).catch(() => undefined);
      return response?.ok ? true : undefined;
    },
    180_000,
    () => (child.exitCode === null ? undefined : new Error(`ponder exited with code ${child.exitCode}; see ${logFile}`)),
  );
  return { apiUrl, logFile, stop: () => stopProcess(child) };
};
