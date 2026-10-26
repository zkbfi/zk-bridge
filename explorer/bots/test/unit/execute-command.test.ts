import { describe, expect, it } from "vitest";
import { CommandStartError, executeCommand } from "../../src/prover/execute-command.ts";

describe("executeCommand", () => {
  it("rejects with the command name and the system reason when the process cannot start", async () => {
    const failure = await executeCommand({ command: "/nonexistent/zk-bridge-prover", args: [], environment: {}, timeoutMilliseconds: 10_000 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommandStartError);
    expect((failure as Error).message).toBe("cannot start /nonexistent/zk-bridge-prover: spawn /nonexistent/zk-bridge-prover ENOENT");
  });

  it("reports code 1 for a process that a signal ended, because no exit code exists", async () => {
    const output = await executeCommand({ command: process.execPath, args: ["-e", "process.kill(process.pid, 'SIGKILL')"], environment: {}, timeoutMilliseconds: 10_000 });
    expect(output).toEqual({ code: 1, stdout: "", stderr: "" });
  });
});
