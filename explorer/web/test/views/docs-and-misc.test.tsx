import { screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { hostOf } from "../../src/app/SettingsDialog";
import { Modal } from "../../src/ui/Modal";
import { renderPage } from "../render";

describe("the settings helper", () => {
  it("shows only the host of an endpoint, never a path that could hold a key", () => {
    expect(hostOf("https://rpc.example.org/some/long/path?x=1")).toBe("rpc.example.org");
    expect(hostOf("not a url")).toBe("not a valid URL");
  });
});

describe("the modal", () => {
  const Harness = () => {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>
          opener
        </button>
        {open ? (
          <Modal title="A dialog" onClose={() => setOpen(false)}>
            <button type="button">first</button>
            <button type="button">last</button>
          </Modal>
        ) : null}
      </div>
    );
  };

  it("labels itself, takes focus, keeps Tab inside, closes on Escape and gives focus back", async () => {
    renderPage(<Harness />);
    const opener = screen.getByRole("button", { name: "opener" });
    await userEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "A dialog" });
    expect(dialog).toHaveFocus();
    const close = screen.getByRole("button", { name: "Close" });
    const last = screen.getByRole("button", { name: "last" });
    last.focus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();
  });
});
