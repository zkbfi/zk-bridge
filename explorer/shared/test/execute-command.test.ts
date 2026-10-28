import { describe, expect, it } from "vitest";
import { CommandStartError, CommandTimeoutError, executeCommand } from "../src/prover/execute-command.js";

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

  it("gives the child only the environment it is handed", async () => {
    process.env.PARENT_ONLY = "visible-to-parent";
    try {
      const output = await executeCommand({ command: process.execPath, args: ["-e", "process.stdout.write(String(process.env.PARENT_ONLY)+','+process.env.GIVEN)"], environment: { GIVEN: "yes" }, timeoutMilliseconds: 10_000 });
      expect(output).toMatchObject({ code: 0, stdout: "undefined,yes" });
    } finally {
      delete process.env.PARENT_ONLY;
    }
  });

  it("returns the exit code and the standard error of a failing command", async () => {
    const output = await executeCommand({ command: process.execPath, args: ["-e", "console.error('bad'); process.exit(3)"], environment: {}, timeoutMilliseconds: 10_000 });
    expect(output).toMatchObject({ code: 3, stderr: "bad\n" });
  });

  it("kills a command that outlives its limit", async () => {
    await expect(executeCommand({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"], environment: {}, timeoutMilliseconds: 200 })).rejects.toBeInstanceOf(CommandTimeoutError);
  });
});
