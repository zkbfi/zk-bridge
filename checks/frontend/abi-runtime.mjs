// Runtime proof for H-18: the specification's VAULT_ABI is an array of human-readable strings.
// viem's encodeFunctionData needs JSON ABI objects, so the strings fail at runtime.
// The control case runs the same strings through parseAbi, which must succeed.
// Usage: node abi-runtime.mjs <path to BridgeInterface.tsx>
// The spec file is only read as text. Only double-quoted strings inside VAULT_ABI are extracted.
import { readFileSync } from 'node:fs';
import { encodeFunctionData, parseAbi } from 'viem';

const source = readFileSync(process.argv[2], 'utf8');
const block = source.match(/const VAULT_ABI = \[([\s\S]*?)\] as const/);
if (!block) { console.log('RESULT=no-abi-block'); process.exit(2); }
const signatures = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
console.log(`signatures=${signatures.length}`);

const withDepositArguments = (abi) => encodeFunctionData({
  abi,
  functionName: 'deposit',
  args: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', 1n, 369n],
});

try {
  withDepositArguments(signatures);
  console.log('RESULT=raw-strings-encoded');
} catch (error) {
  console.log(`RESULT=raw-strings-throw: ${String(error.name)}`);
}

try {
  const encoded = withDepositArguments(parseAbi(signatures));
  console.log(`CONTROL=parseAbi-ok selector=${encoded.slice(0, 10)}`);
} catch (error) {
  console.log(`CONTROL=parseAbi-throws: ${String(error.message)}`);
}
