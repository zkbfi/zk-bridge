/**
 * The text of the confirmation screen. Every transaction is shown in full before the user can approve it: chain,
 * contract, function, decoded arguments, value, gas estimate and fees.
 */
import { keccak256 } from 'viem'
import { formatRateAsPercent, formatUnits } from '../format/amounts'
import type { PreparedTransaction } from '../tx/prepare'
import { colored, muted, plain, strong, type Line } from './rich-text'
import { theme } from './theme'

const LABEL_WIDTH = 14

function row(label: string, value: string): Line {
  return [muted(label.padEnd(LABEL_WIDTH)), plain(value)]
}

/**
 * Builds the lines of the review of one prepared transaction.
 *
 * @param prepared The transaction with its nonce, gas and fees.
 * @param position The place in a sequence, for example `Step 2 of 3`, or null for a single transaction.
 * @param calldata `summary` shows the byte length and the digest. `full` shows every byte.
 */
export function reviewLines(prepared: PreparedTransaction, options: { position: string | null; calldata: 'summary' | 'full'; wrapWidth: number }): readonly Line[] {
  const { plan, from, unsigned } = prepared
  const symbol = plan.chain.nativeSymbol
  const calldataBytes = (plan.data.length - 2) / 2
  const lines: Line[] = [
    ...(options.position === null ? [] : [[muted(options.position)] as Line]),
    [strong(plan.title, theme.accent)],
    row('Chain', `${plan.chain.name} (chain id ${plan.chain.chainId})`),
    row('From', from),
    row('Contract', `${plan.contractLabel}`),
    row('Address', plan.to),
    row('Function', plan.functionSignature),
    [muted('Arguments')],
    ...plan.arguments.map((argument): Line => [
      muted(`  ${argument.name}`.padEnd(LABEL_WIDTH)),
      plain(argument.value),
      ...(argument.meaning === undefined ? [] : [muted(`  (${argument.meaning})`)]),
    ]),
    row('Value', `${formatUnits(plan.value, 18)} ${symbol}`),
    row('Nonce', String(unsigned.nonce)),
    row('Gas', `estimate ${prepared.gasEstimate}, limit ${prepared.gasLimit}`),
    row(
      'Network fee',
      `at most ${formatUnits(prepared.maximumNetworkFee, 18)} ${symbol} (max fee ${formatUnits(unsigned.maxFeePerGas ?? 0n, 9)} gwei, tip ${formatUnits(unsigned.maxPriorityFeePerGas ?? 0n, 9)} gwei)`,
    ),
    ...(plan.charge === null
      ? []
      : [
          row(
            'Bridge fee',
            `${formatRateAsPercent(plan.charge.rate)} = ${formatUnits(plan.charge.amount, plan.charge.token.decimals)} ${plan.charge.token.symbol}, taken by the mediator`,
          ),
        ]),
    ...plan.notes.map((note): Line => [colored(`* ${note}`, theme.warn)]),
    ...(options.calldata === 'full'
      ? [[muted(`Calldata (${calldataBytes} bytes)`)] as Line, ...wrapHexLines(plan.data, options.wrapWidth)]
      : [row('Calldata', `${calldataBytes} bytes, keccak256 ${keccak256(plan.data)}  (press d for every byte)`)]),
  ]
  return lines
}

/** Splits a long hex string into lines of a width, for the full calldata view. */
export function wrapHexLines(text: string, width: number): readonly Line[] {
  const lines: Line[] = []
  for (let start = 0; start < text.length; start += width) lines.push([plain(text.slice(start, start + width))])
  return lines
}
