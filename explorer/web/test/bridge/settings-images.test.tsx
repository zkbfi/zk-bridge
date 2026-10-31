import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { SettingsDialog } from "../../src/app/SettingsDialog";
import { loadImageServer } from "../../src/bridge/image-server";
import { disconnectedWallet, renderWithWallet } from "../app/support";

beforeEach(() => window.localStorage.clear());

const renderSettings = () =>
  renderWithWallet(<SettingsDialog theme="system" onTheme={() => undefined} onRecentCleared={() => undefined} onClose={() => undefined} />, { wallet: disconnectedWallet() });

describe("the image server in the settings", () => {
  it("shows gib.show, saves a replacement, and resets", async () => {
    renderSettings();
    const field = screen.getByRole("textbox", { name: "Image server" });
    expect(field).toHaveValue("https://gib.show/image/{chainId}/{address}");
    await userEvent.clear(field);
    await userEvent.type(field, "https://icons.example.org/{{chainId}/{{address}");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(loadImageServer()).toBe("https://icons.example.org/{chainId}/{address}");
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(loadImageServer()).toBe("https://gib.show/image/{chainId}/{address}");
  });

  it("says why a replacement is refused", async () => {
    renderSettings();
    const field = screen.getByRole("textbox", { name: "Image server" });
    await userEvent.clear(field);
    await userEvent.type(field, "http://icons.example.org/");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Use an https:// address.")).toBeInTheDocument();
  });
});
