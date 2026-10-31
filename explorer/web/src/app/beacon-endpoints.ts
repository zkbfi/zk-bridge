import { defaultBeaconUrls } from "@terminal/config/default-beacon";
import type { ResolvedConnection } from "@zk-bridge/shared";

/**
 * The beacon APIs to read a chain from, in order (the Settings "Beacon endpoints", one per chain). Like the RPC
 * transport: while the setting in force is the chain's default, the whole default list stands behind it (valve.city,
 * then the public keyless node), so one provider's outage or quota does not stop a read; a URL the user or the build
 * chose is used alone.
 *
 * @param resolved The settings in force.
 * @param chainId The chain.
 */
export const beaconUrlsFor = (resolved: Pick<ResolvedConnection, "beaconUrls">, chainId: number): readonly string[] => {
  const defaults = defaultBeaconUrls(chainId);
  const setting = resolved.beaconUrls?.[chainId] ?? null;
  if (setting === null) return defaults;
  return setting.source === "default" && setting.value === defaults[0] ? defaults : [setting.value];
};
