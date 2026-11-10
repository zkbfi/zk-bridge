import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyValue } from "../../src/ui/CopyValue";

const hash = `0x${"ab".repeat(32)}`;
afterEach(() => vi.restoreAllMocks());

describe("CopyValue", () => {
  it("copies the full value on click and says Copied in a polite status", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopyValue value={hash} label="Copy transaction hash">0xabab…abab</CopyValue>);
    const button = screen.getByRole("button", { name: "Copy transaction hash" });
    expect(button).toHaveAttribute("title", "Copy transaction hash");
    await userEvent.click(button);
    expect(writeText).toHaveBeenCalledWith(hash);
    expect(await screen.findByText("Copied")).toHaveAttribute("aria-live", "polite");
  });

  it("copies on Enter and Space when focused", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopyValue value={hash} label="Copy block hash" />);
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("falls back to the selection when the clipboard refuses", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => Promise.reject(new Error("denied")) }, configurable: true });
    const command = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: command, configurable: true });
    render(<CopyValue value={hash} label="Copy block hash" />);
    await userEvent.click(screen.getByRole("button", { name: "Copy block hash" }));
    expect(command).toHaveBeenCalledWith("copy");
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });
});
