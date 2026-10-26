import { screen, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import { useQueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Providers } from "../../src/app/Providers";
import { createServices, useServices } from "../../src/app/services";
import { readConfiguration } from "../../src/config/environment";
import { useWallet } from "../../src/wallet/wallet-port";

const Probe = () => {
  const wallet = useWallet();
  const { configuration } = useServices();
  const client = useQueryClient();
  const queries = client.getDefaultOptions().queries;
  return (
    <p data-testid="probe">
      {configuration.dataMode} {wallet.kind} {wallet.status} retry={String(queries?.retry)} focus={String(queries?.refetchOnWindowFocus)}
    </p>
  );
};

describe("Providers", () => {
  it("gives a fixture page a simulated wallet that starts disconnected, and a data cache that retries once", () => {
    const services = createServices(readConfiguration({ VITE_EXPLORER_DATA: "fixture" }), FIXTURE_PAIR);
    render(
      <Providers services={services}>
        <Probe />
      </Providers>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("fixture simulated disconnected retry=1 focus=false");
  });

  it("gives a live page the wallet of the browser", async () => {
    const configuration = readConfiguration({
      VITE_EXPLORER_DATA: "live",
      VITE_EXPLORER_DEPLOYMENT_URL: "https://example.org/deployment.json",
      VITE_EXPLORER_RPC_URL_1: "https://eth.example.org",
      VITE_EXPLORER_RPC_URL_369: "https://pls.example.org",
    });
    const services = createServices(configuration, FIXTURE_PAIR);
    render(
      <Providers services={services}>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("live real disconnected retry=1 focus=false"));
  });
});
