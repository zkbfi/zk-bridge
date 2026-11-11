import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Header } from "../../src/bridge/Header";

const show = (page: string, onSearch = vi.fn()) => {
  const view = render(<Header page={page} screenHref={(screen) => `#/${screen.toLowerCase()}`} homeHref="#/bridge" onSearch={onSearch} />);
  return { ...view, onSearch };
};

describe("the header", () => {
  it("shows the three screens with the open one lit, chevrons to its neighbours, and the page dots", () => {
    const { container } = show("Bridge");
    expect(screen.getByTestId("page-name")).toHaveTextContent("Bridge");
    expect(screen.getByRole("link", { name: "Previous screen: Activity" })).toHaveAttribute("href", "#/activity");
    expect(screen.getByRole("link", { name: "Next screen: Explore" })).toHaveAttribute("href", "#/explore");
    expect(container.querySelectorAll(".zb-pages span")).toHaveLength(3);
    expect(container.querySelector(".zb-pages .on")).not.toBeNull();
  });

  it("has no chevron before the first screen or after the last", () => {
    const first = show("Activity");
    expect(screen.queryByRole("link", { name: /^Previous screen/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Next screen: Bridge" })).toBeInTheDocument();
    first.unmount();
    show("Explore");
    expect(screen.queryByRole("link", { name: /^Next screen/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Previous screen: Bridge" })).toBeInTheDocument();
  });

  it("names any other page as it is, with no neighbours and no page dots, and still searches", async () => {
    const { container, onSearch } = show("Docs");
    expect(screen.getByTestId("page-name")).toHaveTextContent("Docs");
    expect(screen.queryByRole("link", { name: /screen:/ })).toBeNull();
    expect(container.querySelector(".zb-pages")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Search and jump/ }));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "zkb.fi, the bridge" })).toHaveAttribute("href", "#/bridge");
  });
});
