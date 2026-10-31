import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CloseButton, DEFAULT_IMAGE_SERVER, ReviewNotice, ReviewRow, ReviewSheet, Sheet, TokenIcon, iconUrl } from "../src/index.js";

describe("iconUrl", () => {
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

  it("asks the default image server, with the chain alone when there is no token", () => {
    expect(iconUrl({ chainId: 1, address: USDC })).toBe(`https://gib.show/image/1/${USDC}`);
    expect(iconUrl({ chainId: 8453 })).toBe("https://gib.show/image/8453");
    expect(iconUrl({ chainId: 8453, address: null })).toBe("https://gib.show/image/8453");
    expect(DEFAULT_IMAGE_SERVER).toContain("{chainId}/{address}");
  });

  it("asks the host's image server", () => {
    expect(iconUrl({ chainId: 8453 }, { imageServer: "https://img.example/{chainId}/{address}" })).toBe("https://img.example/8453");
    expect(iconUrl({ chainId: 8453, address: USDC }, { imageServer: "https://img.example/{chainId}/{address}" })).toBe(`https://img.example/8453/${USDC}`);
  });

  it("uses the copy the host ships, under its path, for a chain and for a token (by lowercase address)", () => {
    const shipped = { "1": { file: "1.svg" }, [`1/${USDC.toLowerCase()}`]: { file: "usdc.png" } };
    expect(iconUrl({ chainId: 1 }, { shipped })).toBe("./icons/1.svg");
    expect(iconUrl({ chainId: 1, address: USDC }, { shipped, shippedBase: "/static/" })).toBe("/static/usdc.png");
    // Only its own keys count, not what every object inherits.
    expect(iconUrl({ chainId: 1, address: null }, { shipped: {} })).toBe("https://gib.show/image/1");
    expect(iconUrl({ chainId: 1 }, { shipped: Object.create({ "1": { file: "x.svg" } }) as Record<string, { file: string }> })).toBe("https://gib.show/image/1");
  });
});

describe("TokenIcon", () => {
  it("draws through <img> only, with the badge only when asked", () => {
    const { container, rerender } = render(<TokenIcon subject={{ chainId: 1 }} symbol="ETH" />);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("[data-badge]")).toBeNull();
    expect(screen.getByRole("img", { name: "ETH" })).toHaveAttribute("src", "https://gib.show/image/1");
    rerender(<TokenIcon subject={{ chainId: 1 }} symbol="ETH" badgeChainId={369} imageServer="https://img.example/{chainId}/{address}" shipped={{ "369": { file: "369.png" } }} shippedBase="/i/" />);
    expect(container.querySelector("[data-badge]")).toHaveAttribute("src", "/i/369.png");
    expect(container.querySelector("img.zb-main")).toHaveAttribute("src", "https://img.example/1");
  });

  it("is silent to screen readers when decorative", () => {
    const { container } = render(<TokenIcon subject={{ chainId: 1 }} symbol="ETH" decorative />);
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
  });

  it("sits on a neutral plate, 2 px around it, when the surface is the accent", () => {
    const { container, rerender } = render(<TokenIcon subject={{ chainId: 1 }} symbol="ETH" surface="accent" size={28} />);
    expect(container.querySelector(".zb-tok-icon")).toHaveClass("zb-on-accent");
    expect(container.querySelector(".zb-tok-icon")).toHaveStyle({ width: "32px", height: "32px" });
    rerender(<TokenIcon subject={{ chainId: 1 }} symbol="ETH" size={28} />);
    expect(container.querySelector(".zb-tok-icon")).not.toHaveClass("zb-on-accent");
    expect(container.querySelector(".zb-tok-icon")).toHaveStyle({ width: "28px", height: "28px" });
  });

  it("falls back to a lettered disc when the image fails, and drops a badge that fails", () => {
    const { container } = render(<TokenIcon subject={{ chainId: 1 }} symbol="zkbUSDC" badgeChainId={369} size={32} />);
    fireEvent.error(container.querySelector("img.zb-badge")!);
    expect(container.querySelector("img.zb-badge")).toBeNull();
    fireEvent.error(container.querySelector("img.zb-main")!);
    const fallback = screen.getByRole("img", { name: "zkbUSDC" });
    expect(fallback).toHaveTextContent("USD");
    expect(fallback).toHaveStyle({ fontSize: "11px" });
    expect(container.querySelector("img")).toBeNull();
  });

  it("keeps the letters of a tiny icon readable", () => {
    const { container } = render(<TokenIcon subject={{ chainId: 1 }} symbol="ETH" size={8} />);
    fireEvent.error(container.querySelector("img.zb-main")!);
    expect(screen.getByRole("img", { name: "ETH" })).toHaveStyle({ fontSize: "5px" });
  });
});

describe("Sheet", () => {
  it("is a named dialog with a title and a close button; Escape, the scrim and the button close it", async () => {
    const onClose = vi.fn();
    const { container } = render(<Sheet label="Details" onClose={onClose}><input aria-label="field" /></Sheet>);
    expect(screen.getByRole("dialog", { name: "Details" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("heading", { name: "Details" })).toBeVisible();
    // Focus moves in: to the first control, the close button of the head.
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    await userEvent.click(container.querySelector(".zb-scrim")!);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("can hide its title, hang from the top, and go bare", () => {
    render(<Sheet label="Search" showTitle={false} top bare onClose={() => undefined}><input aria-label="q" /></Sheet>);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByRole("dialog")).toHaveClass("zb-sheet", "zb-sheet-top", "zb-sheet-bare");
    expect(screen.getByLabelText("q")).toHaveFocus();
  });

  it("returns focus to where it was, and stops listening, when it closes", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const { unmount } = render(<Sheet label="x" onClose={onClose}>text</Sheet>);
    unmount();
    expect(opener).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    opener.remove();
  });

  it("takes focus to nothing when it holds no control", () => {
    render(<Sheet label="x" showTitle={false} onClose={() => undefined}>text</Sheet>);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("has a close button with its own label", () => {
    const onClose = vi.fn();
    render(<CloseButton onClose={onClose} label="Back" />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ReviewSheet", () => {
  it("is the sheet named Review, with rows, sub rows and notices", () => {
    render(
      <ReviewSheet onClose={() => undefined}>
        <ReviewRow label="You send"><b>1 ETH</b></ReviewRow>
        <ReviewRow label="Gas" sub><span>$1</span></ReviewRow>
        <ReviewNotice role="alert">Check the receiver.</ReviewNotice>
        <ReviewNotice role="group" groupLabel="Fee cap">Lower the cap.</ReviewNotice>
        <ReviewNotice>Plain.</ReviewNotice>
      </ReviewSheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "Review" });
    expect(screen.getByText("You send").parentElement).toHaveClass("zb-kv");
    expect(screen.getByText("You send").parentElement).not.toHaveClass("zb-kv-sub");
    expect(screen.getByText("Gas").parentElement).toHaveClass("zb-kv", "zb-kv-sub");
    expect(screen.getByRole("alert")).toHaveTextContent("Check the receiver.");
    expect(screen.getByRole("group", { name: "Fee cap" })).toHaveTextContent("Lower the cap.");
    expect(screen.getByText("Plain.")).toHaveClass("zb-warnbox");
    expect(screen.getByText("Plain.")).not.toHaveAttribute("role");
    expect(dialog.querySelector(".zb-review")).not.toBeNull();
  });

  it("takes another label and closes on Escape", () => {
    const onClose = vi.fn();
    render(<ReviewSheet label="Check it" onClose={onClose}>x</ReviewSheet>);
    expect(screen.getByRole("dialog", { name: "Check it" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
