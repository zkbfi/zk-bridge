import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { auditDifference } from "@terminal/model/audit";
import { buildFixtureFeed, FIXTURE_AUDIT, FIXTURE_NOW, FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { AuditRow, PairSummary } from "@terminal/model/types";
import { AuditView } from "../../src/views/AuditView";
import { auditVerdict, tallyAudit } from "../../src/views/audit-model";
import { PairView } from "../../src/views/pair/PairView";
import { SummaryBar } from "../../src/views/pair/SummaryBar";
import { buildTestServices, renderPage } from "../render";
import { renderWithServices, withDataSource } from "./support";

const NOTE = "RPC fallback: recent history only";

const completeSummary = async (): Promise<PairSummary> => buildTestServices().dataSource.getSummary(FIXTURE_PAIR.id);

const renderSummary = async (changes: Partial<PairSummary>) => {
  const summary = { ...(await completeSummary()), ...changes };
  renderPage(<SummaryBar pair={FIXTURE_PAIR} summary={summary} error={null} now={FIXTURE_NOW} />);
  return screen.getByLabelText("Summary");
};

describe("the summary bar with partial figures", () => {
  it("shows no mark and no note for the figures of the indexer", async () => {
    const list = await renderSummary({});
    expect(list).not.toHaveTextContent("at least");
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it("puts at least before each figure that the RPC source marks, and before no other", async () => {
    const list = await renderSummary({ partial: ["inFlight", "volume24h"] });
    const inFlight = within(list).getByText("In flight").nextElementSibling;
    const volume = within(list).getByText("Volume, 24 hours").nextElementSibling;
    const fees = within(list).getByText("Fees accrued").nextElementSibling;
    expect(inFlight?.textContent).toMatch(/^at least \d+$/);
    expect(volume?.textContent).toMatch(/^at least \d+ transfers/);
    expect(fees?.textContent).not.toContain("at least");
  });

  it("marks the fees when the fees are the partial figure, and shows the note once", async () => {
    const list = await renderSummary({ partial: ["feesAccrued"] });
    expect(within(list).getByText("Fees accrued").nextElementSibling?.textContent).toMatch(/^at least /);
    expect(screen.getAllByText(NOTE)).toHaveLength(1);
  });

  it("shows no mark before none when no fee was seen, but still shows the note", async () => {
    const list = await renderSummary({ partial: ["feesAccrued"], feesAccrued: [] });
    expect(within(list).getByText("Fees accrued").nextElementSibling?.textContent).toBe("none");
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it("shows no note for a partial figure that the bar does not show", async () => {
    await renderSummary({ partial: ["audit", "feed"] });
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});

const complete: AuditRow = FIXTURE_AUDIT[2]!;
const partialRow: AuditRow = { ...complete, partial: true };

describe("the audit rules for partial rows", () => {
  it("treats the same non-zero difference as a mismatch when the row is complete and as unverified when it is partial", () => {
    expect(auditDifference(complete)).not.toBe(0n);
    expect(auditDifference(partialRow)).toBe(auditDifference(complete));
    expect(auditVerdict(complete)).toBe("mismatch");
    expect(auditVerdict(partialRow)).toBe("unverified");
  });

  it("treats a complete row with no difference as a match, and a partial row with no difference as unverified", () => {
    expect(auditVerdict(FIXTURE_AUDIT[0]!)).toBe("matches");
    expect(auditVerdict({ ...FIXTURE_AUDIT[0]!, partial: true })).toBe("unverified");
    expect(auditVerdict({ ...complete, partial: false })).toBe("mismatch");
  });

  it("counts a partial row as unverified and never as a mismatch", () => {
    expect(tallyAudit([complete, partialRow, FIXTURE_AUDIT[0]!])).toEqual({ mismatches: 1, unverified: 1, checked: 2 });
    expect(tallyAudit([])).toEqual({ mismatches: 0, unverified: 0, checked: 0 });
  });
});

describe("the audit view with partial rows", () => {
  it("draws a partial row as unverified, not as a mismatch, and says how many rows are unverified", async () => {
    renderWithServices(<AuditView />, withDataSource({ getAudit: async () => [FIXTURE_AUDIT[0]!, partialRow] }));
    expect(await screen.findByText(/^1 of 2 tokens are unverified \(recent history only\)\./)).toBeInTheDocument();
    const row = screen.getByText("WPLS").closest("tr")!;
    expect(within(row).getByText("unverified (recent history only)")).toBeInTheDocument();
    expect(within(row).queryByText("Mismatch")).toBeNull();
    expect(within(row).getByText("unknown")).toBeInTheDocument();
    expect(screen.getByText("All 1 checked tokens match.")).toBeInTheDocument();
    expect(screen.queryByText(/do not match/)).toBeNull();
  });

  it("still flags a complete row with the same difference, next to the unverified one", async () => {
    renderWithServices(<AuditView />, withDataSource({ getAudit: async () => [complete, { ...partialRow, token: FIXTURE_AUDIT[1]!.token }] }));
    expect(await screen.findByText(/^1 of 2 tokens do not match\./)).toBeInTheDocument();
    expect(within(screen.getByText("WPLS").closest("tr")!).getByText("Mismatch")).toBeInTheDocument();
    expect(within(screen.getByText("WETH").closest("tr")!).getByText("unverified (recent history only)")).toBeInTheDocument();
  });

  it("says nothing about matches when every row is unverified", async () => {
    renderWithServices(<AuditView />, withDataSource({ getAudit: async () => [partialRow] }));
    expect(await screen.findByText(/^1 of 1 tokens are unverified/)).toBeInTheDocument();
    expect(screen.queryByText(/tokens match\./)).toBeNull();
  });
});

describe("the pair feed with a covered-from time", () => {
  const feedPage = (coveredFrom?: number) => ({ items: buildFixtureFeed(FIXTURE_NOW).slice(0, 3), hasMore: true, ...(coveredFrom === undefined ? {} : { coveredFrom }) });

  it("shows a muted notice with the UTC time above the table, and keeps the control for older rows", async () => {
    renderWithServices(<PairView pairId="eth-pls" initialToken={null} />, withDataSource({ getFeed: async () => feedPage(1_792_929_600) }));
    const notice = await screen.findByText("RPC fallback: history since 2026-10-25 12:00:00 UTC");
    const table = await screen.findByRole("table", { name: "Transfers and messages" });
    expect(notice.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show older rows" })).toBeInTheDocument();
  });

  it("shows no notice for a page of the whole history", async () => {
    renderWithServices(<PairView pairId="eth-pls" initialToken={null} />, withDataSource({ getFeed: async () => feedPage() }));
    await screen.findByRole("table", { name: "Transfers and messages" });
    await waitFor(() => expect(screen.queryByText(/RPC fallback: history since/)).toBeNull());
  });
});
