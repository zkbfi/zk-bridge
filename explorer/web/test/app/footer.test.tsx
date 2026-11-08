import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Footer } from "../../src/app/Footer";
import { releaseInfo } from "../../src/app/release-version";
import { SOCIAL_LINKS, type SocialLink } from "../../src/app/social-links";
import { Shell } from "../../src/app/Shell";
import { disconnectedWallet, walletWrapper } from "./support";

describe("releaseInfo", () => {
  it("links a real version to its release page", () => {
    expect(releaseInfo("0.1.2-next.16", false)).toEqual({ label: "0.1.2-next.16", href: "https://github.com/zkbfi/releases/releases/tag/v0.1.2-next.16" });
  });
  it("says dev without a version, with a blank one, or on sample data", () => {
    expect(releaseInfo(undefined, false)).toEqual({ label: "dev", href: null });
    expect(releaseInfo("  ", false)).toEqual({ label: "dev", href: null });
    expect(releaseInfo("0.1.2", true)).toEqual({ label: "dev", href: null });
  });
});

describe("the footer", () => {
  const all: readonly SocialLink[] = [
    { name: "GitHub", url: "https://example.org/g", icon: "github" },
    { name: "X", url: "https://example.org/x", icon: "x" },
    { name: "Discord", url: "https://example.org/d", icon: "discord" },
    { name: "Telegram", url: "https://example.org/t", icon: "telegram" },
    { name: "Unset", url: "", icon: "x" },
  ];

  it("shows the version as a link and every link that has a url, by accessible name", () => {
    render(<Footer release={releaseInfo("0.1.2-next.16", false)} links={all} />);
    const version = screen.getByRole("link", { name: "0.1.2-next.16" });
    expect(version).toHaveAttribute("href", "https://github.com/zkbfi/releases/releases/tag/v0.1.2-next.16");
    const list = screen.getByRole("list", { name: "Social links" });
    expect(within(list).getAllByRole("link").map((a) => a.getAttribute("aria-label"))).toEqual(["GitHub", "X", "Discord", "Telegram"]);
    for (const a of within(list).getAllByRole("link")) expect(a).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows dev as plain text and no list when no link has a url", () => {
    render(<Footer release={releaseInfo(undefined, false)} links={[{ name: "X", url: "", icon: "x" }]} />);
    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("ships with Telegram then the public releases repository, and no private repository", () => {
    expect(SOCIAL_LINKS.map((l) => l.url)).toEqual(["https://t.me/zkbfi", "https://github.com/zkbfi/releases"]);
  });
});

describe("the footer in the page", () => {
  it("is the last child of the page frame, after the body, so it is not fixed over the content", () => {
    window.location.hash = "#/bridge";
    const { container } = render(<Shell />, { wrapper: walletWrapper({ wallet: disconnectedWallet() }) });
    const frame = container.querySelector(".zb") as HTMLElement;
    const kids = Array.from(frame.children);
    expect(kids.map((k) => k.className.split(" ")[0])).toContain("zb-body");
    const footer = frame.querySelector("footer.zb-footer") as HTMLElement;
    expect(footer.previousElementSibling?.className).toBe("zb-body");
    expect(footer.parentElement).toBe(frame);
    expect(within(footer).getByText("dev")).toBeInTheDocument();
  });
});
