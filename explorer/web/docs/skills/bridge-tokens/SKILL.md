---
name: bridge-tokens
description: Sends tokens or the native coin from one chain of the bridge to the other in the zkb.fi dapp, to your own wallet or to another address. Use when a person asks to bridge, move or send tokens between the two chains of a pair, or asks what a transfer will cost and how long it takes.
kind: skill
title: Bridge tokens
summary: Send tokens between the two chains in the dapp, read the Bridge button, confirm in the wallet.
audience: [user]
chains: all
verified_release: 0.1.2-next.14
---

# Bridge tokens

## When to use

- The person wants to move a token, or the native coin (ETH, PLS), from one chain of a pair to the other.
- The person asks what the fee is, what arrives, or how long it takes before they sign.

Do not use it to follow a transfer that is already sent (use `check-transfer-status`) or to call a contract on the other chain (see the page `sending-messages`).

## Preconditions

- A browser wallet that holds the token, and a little of the source chain's coin for gas (ETH on Ethereum and Sepolia, PLS on PulseChain and PulseChain testnet v4).
- The dapp is open on the Bridge screen. Until the main pair is live, the dapp opens on Sepolia and PulseChain testnet v4. The dapp says on its first page that the bridge is new software with no completed independent audit: tell the person to send only what they can afford to lose.
- To try the screens without a wallet, the dapp has a sample mode. It shows "Sample data. Nothing here reaches a chain." and simulates every send.

<!-- TODO: confirm with the owner whether a send from a chain whose deposit gate enforces (Sepolia today) needs a gate confirmation first. @zkb/data has ensureGateConfirmed for it, and its README says the web send flow does not call it yet; no call to it exists in explorer/web/src. The Bridge button label "<route> is paused" appears when the gate reads "stop" or "sealed". -->

## Steps

1. Tap **Connect wallet** and choose the wallet. (When no wallet is connected, the Bridge button reads "Connect wallet" and pressing it opens the wallet connection.)
2. Choose the direction. Tap the chain beside **From**, or tap the round button between the two halves of the screen to swap the direction.
3. Choose the token. Tap the token beside the amount to open the token list. The tabs filter by chain (the first tab shows all chains). Search finds every token the bridge knows on both chains; picking a token on the other chain swaps the direction. To bridge a token nobody has bridged yet, paste its address.
4. Type the amount. **MAX** fills your balance. On the native coin, MAX leaves enough for the gas of sending it.
5. Read the delivery control under the amount. It has three parts: who delivers and the fee (such as "A bot delivers it · 0.39%"), the gas level (Low, Normal, High; Normal is the default), and the time to arrival (such as "~15 min"). Leave the defaults unless the person wants to change them (see "Fee" below).
6. Check the **To** row. It is locked to the connected wallet. To send somewhere else, tap the lock and type the address. The address must be 0x and 40 hex characters, must not be the zero address, and if it has capital letters they must match the checksum. Until it passes, the button is grey and reads "Check the destination". When the address differs from the wallet, a line reads "Not your wallet. Check the address." The same address on the other chain can belong to someone else, or to nobody: for a contract wallet, check that it exists on the destination chain, and test with a small amount first.
7. Read the Bridge button before pressing it (see "The Bridge button" below).
8. Tap the button (label **Bridge**). The review opens. Check these rows: **You send**, **Arrives**, **Fee**, **Time**, **To** (with "(not your wallet)" when it differs), and **Relay router** when a bot delivers it. The review also names any field that a link filled in for you.
9. Tap **Confirm in wallet**. A dialog titled "Review before you sign" opens. For each transaction it lists the Chain, From, Contract, Function and Value sent. If the token's allowance is lower than the amount, the approval comes first and the transfer second. Check each one, tap **Send to wallet**, and sign in the wallet. With a hardware wallet, read the device screen too.
10. The transfer appears on the Activity screen the moment it is sent. Follow it there (see `check-transfer-status`).

### Fee

- Default ("Automatic"): 1% of the amount at $10 and below, sliding down to 0.1% at $500 and above (about $0.25 at $100, $0.50 at $500, $1.00 at $1,000), but never below twice the cost of the delivery. The cost is the delivery gas plus $0.025 for the proof. The fee comes out of the amount: what arrives is the amount less the fee.
- Without a dollar price (the testnets), the automatic fee is 0.1% of the amount, or the automatic cap if that is lower.
- Tap the fee in the delivery control to open the delivery menu. **Who delivers** offers Automatic, Share, Fixed, Gas-based or Yourself. **Yourself** means no fee and no router: anyone, including you, delivers it on the destination chain for free, and it can take longer.
- Two caps limit the fee: the automatic fee cap (1% of the amount by default) and the hard fee cap (2% by default).
- Bridging the native coin carries no fee for a bot, so it is delivered like the **Yourself** choice.

### The Bridge button

| Look | Labels you may see | What to do |
|---|---|---|
| Solid | Bridge | Ready. |
| Orange outline | "Small transfer · may not be delivered in a timely manner"; "Tip too low · may not be delivered"; "High cap %"; "Already bridged by the Omnibridge · wraps twice"; "First time this token is bridged · keep the amount low" | A warning. Read the line under the button. The person can still go ahead. At most one shows at a time. |
| Grey | "Enter an amount"; "Not enough <symbol>"; "Check the destination"; "Check the transfer"; "Fee above your <cap> cap"; "<route> is paused" | Fix what the line under the button says. For "Fee above your <cap> cap", the button "Raise cap to <n>%" raises the hard cap to the smallest step that admits the fee. |

## Expected result

- After **Confirm in wallet** and every signature, the dialog says "Done. Every transaction is confirmed." and has a **Close** button.
- Time to arrival, from the dapp's own step list: about 15 minutes from Ethereum or Sepolia (12 s send, 768 s finality, 120 s proof, then two 10 to 12 s steps), about 13 minutes from PulseChain or PulseChain testnet v4 (640 s finality).
- The transfer moves through Sent, Final, Proven and Delivered. The recipient receives the amount less the fee, as shown in the **Arrives** row.
- Bridged copies take the native token's name plus " from " and the home chain, with the symbol prefix "z": USDC sent from Ethereum arrives as "zUSDC".

## If it fails

- **The button is grey.** Read the line under it. The labels in the table above each name one cause.
- **"Fee above your <cap> cap".** The fee, or for a gas-based fee the most it could reach, is above the hard cap. Raise the cap, or lower the fee.
- **A warning about the fee ("Tip too low", "Small transfer").** Bots are likely to skip the transfer. Raise the tip or the automatic cap, send more, or plan to deliver it yourself (see `deliver-it-yourself`).
- **The transfer waits.** If it is proven and still undelivered 30 minutes after sending, it moves to **Needs you** on the Activity screen. See `deliver-it-yourself`.
- **The receiver cannot take the tokens** (for example a deny-listed address). The status becomes `release_failed`. This is final: the tokens stay in the token mediator, with no claim and no fallback address. Check the destination address before you send.
- **The wallet rejects, or a transaction fails.** The dialog shows the error with **Close** and **Try again**. When one of its transactions reverted, it shows only **Close**: start again from the Bridge screen.
- **A link filled in the form.** A link can set direction, token and amount quietly, and names any field that changes where the tokens go or what you pay (destination, fee settings, relay router, gas limit, a call). Check those before confirming.

## References

- `getting-started`: the first transfer, step by step.
- `bridging-tokens`: the token list, native copies, the destination, the allowance.
- `fees-explained`: the fee, the gas level, the caps, every warning.
- `safety`: what you trust.
- `check-transfer-status`, `deliver-it-yourself`: what to do after you send.
