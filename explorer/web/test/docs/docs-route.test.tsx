import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocsRoute } from "../../src/docs/DocsRoute";

describe("DocsRoute", () => {
  it("shows a loading line, then the docs site on the page and heading of the address", async () => {
    render(<DocsRoute slug="fees-explained" heading="the-data-source-of-each-number" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the docs");
    expect(await screen.findByRole("heading", { level: 1, name: "Fees explained" }, { timeout: 20000 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "The data source of each number" })).toBeInTheDocument();
  });

  it("shows the front page of the docs with no slug", async () => {
    render(<DocsRoute slug={null} heading={null} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Docs" }, { timeout: 20000 })).toBeInTheDocument();
  });
});
