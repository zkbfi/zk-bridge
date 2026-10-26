import { describe, expect, it } from "vitest";
import { spawnRunner } from "../src/config/index.js";

describe("spawnRunner, the command runner of the secret store", () => {
  it("returns the standard output, the standard error and the exit code", async () => {
    const result = await spawnRunner(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"]);
    expect(result).toEqual({ code: 7, stdout: "out", stderr: "err" });
  });

  it("sends the secret through the standard input, so it is in no argument list", async () => {
    const result = await spawnRunner(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], "the-secret-value");
    expect(result.stdout).toBe("the-secret-value");
  });

  it("answers code 127 for a command that does not exist, as a shell does", async () => {
    const result = await spawnRunner("zk-bridge-no-such-command", []);
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("zk-bridge-no-such-command");
  });
});
