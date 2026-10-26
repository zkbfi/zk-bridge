import { Box, Heading, Table, Text } from "@chakra-ui/react";
import { auditDifference } from "@terminal/model/audit";
import { useAudit } from "../app/queries";
import { useServices } from "../app/services";
import { formatUnits } from "../ui/format";
import { Notice } from "../ui/primitives";
import { auditVerdict, tallyAudit, type AuditVerdict } from "./audit-model";

const cell = (value: bigint, decimals: number): string => formatUnits(value, decimals, { groupThousands: true, maximumFractionDigits: 6 });

const DIFFERENCE_TEXT: Readonly<Record<AuditVerdict, (difference: bigint, decimals: number) => string>> = {
  matches: () => "0",
  mismatch: (difference, decimals) => `${difference > 0n ? "+" : ""}${cell(difference, decimals)}`,
  unverified: () => "unknown",
};

const VERDICT_COLORS: Readonly<Record<AuditVerdict, string>> = { matches: "green.fg", mismatch: "red.fg", unverified: "fg.muted" };

const VERDICT_WORDS: Readonly<Record<AuditVerdict, string>> = { matches: "Matches", mismatch: "Mismatch", unverified: "unverified (recent history only)" };

/**
 * The audit view: for each native token, the escrow that the home mediator holds against the supply of its copy on the
 * other chain, with the fees. A difference that is not zero is flagged in words.
 */
export const AuditView = () => {
  const { pair } = useServices();
  const audit = useAudit(pair.id);
  const rows = audit.data;
  const { mismatches, unverified, checked } = tallyAudit(rows ?? []);
  return (
    <Box>
      <Heading as="h1" size="lg" marginBottom="1">
        Audit
      </Heading>
      <Text color="fg.muted" marginBottom="3">
        Escrow on the home chain against the bridged supply on the other chain, and the fees. The two numbers must match, less what is in flight.
      </Text>
      {audit.error === null ? null : <Notice tone="error">The audit did not load: {audit.error.message}</Notice>}
      {rows === undefined ? <Text color="fg.muted">Loading…</Text> : null}
      {rows === undefined ? null : (
        <>
          {checked === 0 ? null : (
            <Notice tone={mismatches === 0 ? "info" : "error"}>
              {mismatches === 0
                ? `All ${unverified === 0 ? rows.length : `${checked} checked`} tokens match.`
                : `${mismatches} of ${rows.length} tokens do not match. Check twice before you raise an alarm: the two chains are read at different blocks.`}
            </Notice>
          )}
          {unverified === 0 ? null : (
            <Notice tone="warning">
              {unverified} of {rows.length} tokens are unverified (recent history only). The RPC fallback cannot see older transfers in flight, so it cannot prove a match or a mismatch.
            </Notice>
          )}
          <Box overflowX="auto" marginTop="3">
            <Table.Root aria-label="Escrow against bridged supply">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader scope="col">Token</Table.ColumnHeader>
                  <Table.ColumnHeader scope="col" textAlign="end">Escrow</Table.ColumnHeader>
                  <Table.ColumnHeader scope="col" textAlign="end">Bridged supply</Table.ColumnHeader>
                  <Table.ColumnHeader scope="col" textAlign="end">In flight</Table.ColumnHeader>
                  <Table.ColumnHeader scope="col" textAlign="end">Difference</Table.ColumnHeader>
                  <Table.ColumnHeader scope="col" textAlign="end">Fees accrued</Table.ColumnHeader>
                  <Table.ColumnHeader scope="col" textAlign="end">Fees collected</Table.ColumnHeader>
                  <Table.ColumnHeader scope="col">Result</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((row) => {
                  const difference = auditDifference(row);
                  const verdict = auditVerdict(row);
                  const decimals = row.token.decimals;
                  return (
                    <Table.Row key={`${row.token.side}-${row.token.address}`}>
                      <Table.Cell>{row.token.symbol}</Table.Cell>
                      <Table.Cell textAlign="end">{cell(row.escrow, decimals)}</Table.Cell>
                      <Table.Cell textAlign="end">{cell(row.bridgedSupply, decimals)}</Table.Cell>
                      <Table.Cell textAlign="end">{cell(row.inFlight, decimals)}</Table.Cell>
                      <Table.Cell textAlign="end">{DIFFERENCE_TEXT[verdict](difference, decimals)}</Table.Cell>
                      <Table.Cell textAlign="end">{cell(row.accruedFees, decimals)}</Table.Cell>
                      <Table.Cell textAlign="end">{cell(row.collectedFees, decimals)}</Table.Cell>
                      <Table.Cell color={VERDICT_COLORS[verdict]} fontWeight="medium">
                        {VERDICT_WORDS[verdict]}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          </Box>
        </>
      )}
    </Box>
  );
};
