import { describe, expect, it } from "vitest";
import { defaultBeaconUrls } from "@terminal/config/default-beacon";
import { beaconUrlsFor } from "../../src/app/beacon-endpoints";

describe("the beacon APIs a chain is read from", () => {
  it("are the chain's whole default list, valve.city first, when the setting in force is the default", () => {
    expect(beaconUrlsFor({ beaconUrls: { 943: { value: "https://one.valve.city/beacon/vk_demo/943", source: "default" } } }, 943)).toEqual(defaultBeaconUrls(943));
    expect(defaultBeaconUrls(943)[1]).toBe("https://rpc-testnet-pulsechain.g4mm4.io/beacon-api");
  });

  it("are the one URL the user or the build chose, alone", () => {
    expect(beaconUrlsFor({ beaconUrls: { 943: { value: "https://mine.example.org", source: "user" } } }, 943)).toEqual(["https://mine.example.org"]);
    expect(beaconUrlsFor({ beaconUrls: { 943: { value: "https://build.example.org", source: "environment" } } }, 943)).toEqual(["https://build.example.org"]);
  });

  it("fall back to the default list when the connection has no beacon setting, and are empty for a chain with none", () => {
    expect(beaconUrlsFor({}, 11155111)).toEqual(defaultBeaconUrls(11155111));
    expect(beaconUrlsFor({ beaconUrls: { 5: null } }, 5)).toEqual([]);
  });
});
