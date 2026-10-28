import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.ts";

describe("logger", () => {
  it("writes one JSON line and removes known values, errors and big integers included", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line), now: () => 0, knownSecrets: () => ["hunter2-value"] });
    logger.info("event", { big: 5n, list: [1, { token: "hunter2-value" }], error: new Error("bad hunter2-value") });
    logger.debug("d");
    logger.warn("w");
    logger.error("e");
    expect(lines).toHaveLength(4);
    expect(lines[0]).not.toContain("hunter2-value");
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", event: "event", big: "5", time: "1970-01-01T00:00:00.000Z" });
  });
});
