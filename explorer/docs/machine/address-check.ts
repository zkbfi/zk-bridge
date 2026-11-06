/**
 * Keeps addresses in page prose honest: every 40 hex digit address in a page must be one of the addresses in
 * `contracts.json` or be listed in `example-addresses.json`. A page that needs a contract address writes a placeholder
 * such as `{{contracts.943.bridge}}` instead, which the build fills from the deployment.
 */

const ADDRESS = /(?<![0-9a-zA-Z])0x[0-9a-fA-F]{40}(?![0-9a-zA-Z])/g;

/**
 * Lists the addresses that match no contract and no example.
 *
 * @param files The source files, with the text as written (placeholders not yet resolved).
 * @param contracts The addresses of `contracts.json`, lowercase.
 * @param examples The allowed example addresses, lowercase.
 * @returns One line per offence, `path:line: address ...`.
 */
export const checkAddresses = (
  files: readonly { readonly path: string; readonly text: string }[],
  contracts: ReadonlySet<string>,
  examples: ReadonlySet<string>,
): string[] => {
  const problems: string[] = [];
  for (const file of files) {
    file.text.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(ADDRESS)) {
        const lower = match[0].toLowerCase();
        if (!contracts.has(lower) && !examples.has(lower)) problems.push(`${file.path}:${index + 1}: ${match[0]} is not in contracts.json and is not a listed example address`);
      }
    });
  }
  return problems;
};
