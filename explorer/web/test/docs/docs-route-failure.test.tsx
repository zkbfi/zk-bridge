import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@docs/DocsPage", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

describe("DocsRoute when the chunk cannot be downloaded", () => {
  it("says so and links to the bridge, instead of leaving a blank page", async () => {
    const { DocsRoute } = await import("../../src/docs/DocsRoute");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<DocsRoute slug={null} heading={null} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The docs could not be loaded");
    expect(screen.getByRole("link", { name: "open the bridge" })).toHaveAttribute("href", "#/");
    quiet.mockRestore();
  });
});
