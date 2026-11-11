import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, CopyValue } from "../../src/ui/CopyValue";

const hash = `0x${"ab".repeat(32)}`;
const SELECTED = "Selected: press Ctrl+C or Cmd+C to copy";

const setClipboard = (value: unknown) => Object.defineProperty(navigator, "clipboard", { value, configurable: true });
const setExecCommand = (value: () => boolean) => Object.defineProperty(document, "execCommand", { value, configurable: true });

afterEach(() => {
  vi.useRealTimers();
  setClipboard(undefined);
  setExecCommand(() => false);
});

describe("copyText", () => {
  it("selects the element and tries the old copy command when the browser has no clipboard", async () => {
    setClipboard(undefined);
    const command = vi.fn(() => true);
    setExecCommand(command);
    const node = document.createElement("span");
    node.textContent = hash;
    document.body.append(node);
    await expect(copyText(hash, node)).resolves.toBe(true);
    expect(command).toHaveBeenCalledWith("copy");
    expect(window.getSelection()?.toString()).toBe(hash);
    node.remove();
  });

  it("gives false when there is no clipboard and nothing to select", async () => {
    setClipboard(undefined);
    await expect(copyText(hash, null)).resolves.toBe(false);
  });

  it("gives false when the old copy command throws", async () => {
    setClipboard(undefined);
    setExecCommand(() => {
      throw new Error("not allowed");
    });
    const node = document.createElement("span");
    await expect(copyText(hash, node)).resolves.toBe(false);
  });
});

describe("CopyValue", () => {
  it("says to press the copy keys when nothing could be copied, and clears the words after two seconds", async () => {
    vi.useFakeTimers();
    setClipboard(undefined);
    setExecCommand(() => false);
    render(<CopyValue value={hash} label="Copy hash" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy hash" }));
    });
    expect(screen.getByRole("status")).toHaveTextContent(SELECTED);
    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(screen.getByRole("status")).toHaveTextContent(SELECTED);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("restarts the two seconds when copied again, and leaves no timer behind when it goes away", async () => {
    vi.useFakeTimers();
    setClipboard({ writeText: async () => undefined });
    const view = render(<CopyValue value={hash} label="Copy hash" />);
    const click = async () =>
      act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy hash" }));
      });
    await click();
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    await click();
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
