import type { Deps } from "../deps.ts";
import type { CheckSpec } from "../types.ts";

/** What `systemctl show` says of a unit. Reading it needs no privilege. */
export const unitCheck = (unit: { readonly name: string; readonly optional: boolean }): CheckSpec<Deps> => ({
  id: `unit-${unit.name.replace(/\.service$/, "")}`,
  name: `${unit.name} (systemd)`,
  section: "services",
  async run(deps) {
    const output = await deps.exec("systemctl", ["show", unit.name, "--no-pager", "--property=LoadState,ActiveState,SubState"]);
    const fields = Object.fromEntries(output.split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    if (fields.LoadState === "not-found") {
      return unit.optional ? { state: "ok", detail: "not installed on this server" } : { state: "down", detail: "the unit is not installed" };
    }
    const where = `${fields.ActiveState} (${fields.SubState})`;
    if (fields.ActiveState === "activating") return { state: "degraded", detail: `${where}: it is restarting` };
    if (fields.ActiveState !== "active") return { state: "down", detail: where };
    return { state: "ok", detail: where };
  },
});
