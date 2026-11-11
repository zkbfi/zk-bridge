import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Providers } from "../../src/app/Providers";
import { createServices } from "../../src/app/services";
import { readConfiguration } from "../../src/config/environment";
import { useWallet } from "../../src/wallet/wallet-port";

afterEach(() => window.history.replaceState(null, "", "/"));

const Probe = () => {
  const wallet = useWallet();
  return (
    <p data-testid="probe">
      {wallet.walletName} {wallet.status} {wallet.account} {wallet.chainId}
    </p>
  );
};

describe("Providers with a watched address (development builds)", () => {
  it("shows the page as the watched account, connected on the first chain of the pair", () => {
    window.history.replaceState(null, "", `/?watch=${FIXTURE_ACCOUNT}`);
    const services = createServices(readConfiguration({ VITE_EXPLORER_DATA: "fixture" }), FIXTURE_PAIR);
    render(
      <Providers services={services}>
        <Probe />
      </Providers>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent(`Watching (development) connected ${FIXTURE_ACCOUNT} ${FIXTURE_PAIR.first.chainId}`);
  });
});
