import { execFile } from "node:child_process";
import { createPublicClient, http } from "viem";
import type { ChainClient } from "./deps.ts";

/** Runs a program without a shell and gives its standard output. Rejects when it exits with an error or takes over 10 s. */
export function execProgram(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error !== null) reject(new Error(`${file} failed: ${error.message.split("\n")[0]}`));
      else resolve(String(stdout));
    });
  });
}

/** A read client of a chain, with the request timeout and no retries: the next round is the retry. */
export function createChainClient(rpcUrl: string, timeoutMilliseconds: number): ChainClient {
  return createPublicClient({ transport: http(rpcUrl, { timeout: timeoutMilliseconds, retryCount: 0 }) });
}
