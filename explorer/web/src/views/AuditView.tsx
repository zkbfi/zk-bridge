import { Box, Heading, Table, Text } from "@chakra-ui/react";
import { auditDifference, countAuditMismatches, hasAuditMismatch } from "@terminal/model/audit";
import { useAudit } from "../app/queries";
import { useServices } from "../app/services";
import { formatUnits } from "../ui/format";
import { Notice } from "../ui/primitives";

const cell = (value: bigint, decimals: number): string => formatUnits(value, decimals, { groupThousands: true, maximumFractionDigits: 6 });

/**
 * The audit view: for each native token, the escrow that the home mediator holds against the supply of its copy on the
 * other chain, with the fees. A difference that is not zero is flagged in words.
 */
export const AuditView = () => {
  const { pair } = useServices();
  const audit = useAudit(pair.id);
  const rows = audit.data;
  const mismatches = rows === undefined ? 0 : countAuditMismatches(rows);
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
          <Notice tone={mismatches === 0 ? "info" : "error"}>
            {mismatches === 0 ? `All ${rows.length} tokens match.` : `${mismatches} of ${rows.length} tokens do not match. Check twice before you raise an alarm: the two chains are read at different blocks.`}
          </Notice>
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
                  const flagged = hasAuditMismatch(row);
                  const decimals = row.token.decimals;
                  return (
                    <Table.Row key={`${row.token.side}-${row.token.address}`}>
                      <Table.Cell>{row.token.symbol}</Table.Cell>
                      <Table.Cell textAlign="end">{cell(row.escrow, decimals)}</Table.Cell>
                      <Table.Cell textAlign="end">{cell(row.bridgedSupply, decimals)}</Table.Cell>
                      <Table.Cell textAlign="end">{cell(row.inFlight, decimals)}</Table.Cell>
                      <Table.Cell textAlign="end">{flagged ? `${difference > 0n ? "+" : ""}${cell(difference, decimals)}` : "0"}</Table.Cell>
                      <Table.Cell textAlign="end">{cell(row.accruedFees, decimals)}</Table.Cell>
                      <Table.Cell textAlign="end">{cell(row.collectedFees, decimals)}</Table.Cell>
                      <Table.Cell color={flagged ? "red.fg" : "green.fg"} fontWeight="medium">
                        {flagged ? "Mismatch" : "Matches"}
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
