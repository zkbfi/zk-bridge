import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "../../src/ui/Modal";
import { renderPage } from "../render";

describe("the modal, edge cases", () => {
  it("closes when the pointer goes down on the backdrop, and not when it goes down inside the panel", () => {
    const onClose = vi.fn();
    renderPage(
      <Modal title="Backdrop" onClose={onClose}>
        <p>content</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Backdrop" });
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on the Close button and on Escape, and keeps the Escape from reaching outer handlers", () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    renderPage(
      <div onKeyDown={outer}>
        <Modal title="Escape" onClose={onClose}>
          <p>content</p>
        </Modal>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(outer).not.toHaveBeenCalled();
  });

  it("gives the first focus to the element that the caller names", () => {
    const reference = createRef<HTMLInputElement>();
    renderPage(
      <Modal title="Focus" onClose={() => undefined} initialFocusReference={reference}>
        <input ref={reference} aria-label="name" />
      </Modal>,
    );
    expect(screen.getByLabelText("name")).toHaveFocus();
  });

  it("falls back to the panel when the named element is not mounted", () => {
    const reference = createRef<HTMLInputElement>();
    renderPage(
      <Modal title="Fallback" onClose={() => undefined} initialFocusReference={reference}>
        <p>content</p>
      </Modal>,
    );
    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  it("wraps Shift+Tab from the panel to the last control, and Tab from the last control to the first", async () => {
    renderPage(
      <Modal title="Wrap" onClose={() => undefined}>
        <button type="button">alpha</button>
        <button type="button">omega</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "omega" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("wraps Shift+Tab from the first control to the last control", async () => {
    renderPage(
      <Modal title="Wrap back" onClose={() => undefined}>
        <button type="button">omega</button>
      </Modal>,
    );
    screen.getByRole("button", { name: "Close" }).focus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "omega" })).toHaveFocus();
  });

  it("lets Tab move on by itself between controls in the middle, and ignores other keys", () => {
    renderPage(
      <Modal title="Middle" onClose={() => undefined}>
        <button type="button">alpha</button>
        <button type="button">omega</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    screen.getByRole("button", { name: "alpha" }).focus();
    expect(fireEvent.keyDown(dialog, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(dialog, { key: "a" })).toBe(true);
  });

  it("leaves Tab alone when no control can take focus", () => {
    renderPage(
      <div hidden>
        <Modal title="Hidden" onClose={() => undefined}>
          <p>content</p>
        </Modal>
      </div>,
    );
    expect(fireEvent.keyDown(screen.getByRole("dialog", { hidden: true }), { key: "Tab" })).toBe(true);
  });

  it("gives focus back to the opener when it closes", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = renderPage(
      <Modal title="Return" onClose={() => undefined}>
        <p>content</p>
      </Modal>,
    );
    expect(opener).not.toHaveFocus();
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("does not fail on close when the focus sat on an element that is not an HTML element", () => {
    const opener = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    opener.setAttribute("tabindex", "0");
    document.body.append(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);
    const view = renderPage(
      <Modal title="Svg" onClose={() => undefined}>
        <p>content</p>
      </Modal>,
    );
    expect(screen.getByRole("dialog")).toHaveFocus();
    view.unmount();
    expect(document.activeElement).toBe(document.body);
    opener.remove();
  });
});
