import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { iconSubjectOf, iconUrl } from "../../src/bridge/image-source";
import { TokenIcon } from "../../src/bridge/TokenIcon";

describe("iconUrl", () => {
  it("uses the copy the release ships for the four chains", () => {
    expect(iconUrl({ chainId: 1 })).toBe("./icons/1.svg");
    expect(iconUrl({ chainId: 369 })).toBe("./icons/369.png");
    expect(iconUrl({ chainId: 943 })).toBe("./icons/943.png");
  });

  it("asks the chosen image server for anything else", () => {
    expect(iconUrl({ chainId: 1, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" })).toBe("https://gib.show/image/1/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(iconUrl({ chainId: 8453 }, "https://img.example/{chainId}/{address}")).toBe("https://img.example/8453");
  });
});

describe("iconSubjectOf", () => {
  it("shows a bridged zkb token with its original's icon", () => {
    const original = { address: "0x1111111111111111111111111111111111111111", symbol: "USDC", decimals: 6, side: "first", counterpart: "0x2222222222222222222222222222222222222222" } as const;
    const bridged = { address: "0x2222222222222222222222222222222222222222", symbol: "zkbUSDC", decimals: 6, side: "second", counterpart: original.address } as const;
    expect(iconSubjectOf(bridged, FIXTURE_PAIR)).toEqual({ chainId: FIXTURE_PAIR.first.chainId, address: original.address });
    expect(iconSubjectOf(original, FIXTURE_PAIR)).toEqual({ chainId: FIXTURE_PAIR.first.chainId, address: original.address });
  });
});

describe("TokenIcon", () => {
  it("always draws icons through <img>, never as inline SVG markup", () => {
    const { container } = render(<TokenIcon subject={{ chainId: 1, address: "0x1111111111111111111111111111111111111111" }} symbol="USDC" badgeChainId={369} />);
    expect(container.querySelectorAll("img")).toHaveLength(2);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("draws the destination badge only when asked", () => {
    const { container, rerender } = render(<TokenIcon subject={{ chainId: 1 }} symbol="ETH" />);
    expect(container.querySelector("[data-badge]")).toBeNull();
    rerender(<TokenIcon subject={{ chainId: 1 }} symbol="ETH" badgeChainId={369} />);
    expect(container.querySelector("[data-badge]")?.getAttribute("src")).toBe("./icons/369.png");
  });

  it("falls back to a lettered disc when the image fails", () => {
    render(<TokenIcon subject={{ chainId: 1, address: "0x1111111111111111111111111111111111111111" }} symbol="zkbUSDC" />);
    fireEvent.error(screen.getByRole("img", { name: "zkbUSDC" }));
    expect(screen.getByRole("img", { name: "zkbUSDC" }).textContent).toBe("USD");
  });
});
