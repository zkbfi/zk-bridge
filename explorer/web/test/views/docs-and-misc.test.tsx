import { screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { hostOf } from "../../src/app/SettingsDialog";
import { parseDocPages } from "../../src/docs/docs-index";
import { DocsView } from "../../src/views/DocsView";
import { Modal } from "../../src/ui/Modal";
import { renderPage } from "../render";

const pages = parseDocPages({
  "/d/01-one.md": "# Page one\n\nText with **bold**.\n\n## First heading\n\n- item a\n- item b\n\n| Year | Rate |\n|---|---|\n| 1 | 0.10% |\n",
  "/d/02-two.md": "# Page two\n\n## Second heading\n\nMore.\n",
});

describe("the docs view", () => {
  it("shows the first page by default, with a list of pages that marks the current one", () => {
    renderPage(<DocsView slug={null} heading={null} pages={pages} />);
    const nav = screen.getByRole("navigation", { name: "Documentation pages" });
    expect(within(nav).getByRole("link", { name: "Page one" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Page two" })).toHaveAttribute("href", "#/docs/two");
    const article = screen.getByRole("article", { name: "Page one" });
    expect(within(article).getByRole("heading", { name: "First heading", level: 2 })).toHaveAttribute("id", "first-heading");
  });

  it("renders lists and tables as real elements", () => {
    renderPage(<DocsView slug="one" heading={null} pages={pages} />);
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("table")).toHaveTextContent("0.10%");
  });

  it("scrolls to the heading that the route names", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderPage(<DocsView slug="two" heading="second-heading" pages={pages} />);
    expect(scroll).toHaveBeenCalled();
  });

  it("says so for a page that does not exist", () => {
    renderPage(<DocsView slug="missing" heading={null} pages={pages} />);
    expect(screen.getByRole("status")).toHaveTextContent('There is no documentation page called "missing"');
  });

  it("renders the real documentation, every page of it", () => {
    renderPage(<DocsView slug="fees-explained" heading={null} />);
    expect(screen.getByRole("heading", { name: "Fees explained", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "The data source of each number" })).toBeInTheDocument();
  });
});

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
