---
title: "Bridging tokens"
summary: "Send tokens or the native coin to the other chain, to your own wallet or any address you choose, and know what arrives."
audience: [user]
chains: all
verified_release: 0.1.0
---

# Bridging tokens

Send tokens or the native coin to the other chain, to your own wallet or any address you choose, and know what arrives.

## Native tokens and bridged copies

A token is native on the chain where it was created. USDC on Ethereum, for example, is native on Ethereum.

When you bridge a native token, the bridge locks it in the token mediator, the contract that handles tokens. The other chain then mints a bridged copy for the recipient. When you bridge the copy back, the bridge burns it, and the mediator unlocks the native token on its home chain. The supply of each copy always matches what the mediator holds.

A copy takes the name of the native token, then " from " and the home chain, such as Wrapped Ether from Ethereum. Its symbol adds the prefix "z", such as zWETH. On the Bridge screen, what arrives shows with the same icon as what you send, with a small badge of the destination chain, and the line under it names the copy: "arrives as zUSDC on PulseChain".

## Choosing the token

Tap the token beside the amount to open the token list.

- The tabs filter by chain: the first tab shows all chains, the others one chain each.
- Each list shows your tokens: those you hold, or have bridged with zkb.fi before. Each row shows the token's price and your balance.
- Search finds every token the bridge knows, on both chains. Picking a token on the other chain swaps the direction for you.
- Paste a token address to bridge a token nobody has bridged yet.

## Tokens to take care with

Two kinds of token get a warning on the Bridge button. You can read it and still go ahead.

- **First time this token is bridged · keep the amount low.** Nobody has bridged this token with zkb.fi before. The first transfer also creates its copy on the other chain, and costs more gas to deliver. A small first amount limits what is at risk.
- **Already bridged by the Omnibridge · wraps twice.** The token is itself a copy that came over the Omnibridge. Bridging it with zkb.fi wraps it a second time: you pay gas twice, and it only turns back into the original by undoing both bridges in order. In the token list such a token carries a bridge icon. Its tooltip explains this and links to the original token.

## Bridging the native coin

The native coin is ETH on Ethereum and PLS on PulseChain. It appears in the token list where the pair supports it. The bridge wraps the coin into a token that stands for it one to one, sends that, and on the other side the coin is paid out again. It is one transaction and needs no allowance.

MAX on the native coin leaves enough for the gas of sending it.

A transfer of the native coin carries no fee for a bot, so anyone can deliver it for free, you included. The page Fees explained covers this.

## The destination

The **To** row above the Bridge button says where the tokens go.

| The lock | The destination | Its tooltip |
|---|---|---|
| Locked (the default) | Your connected wallet. It follows your wallet when you switch accounts. | Sends to your connected wallet |
| Unlocked | The address you type in the row, whatever wallet is connected. | Sends to the address you type, whatever wallet is connected |

Tap the lock to switch. When it is unlocked, the row itself becomes the address field. The page checks the address as you type:

- it must be 0x followed by 40 hex characters;
- it must not be the zero address, where nothing sent can be spent;
- if it has capital letters, they must match the address's checksum. Type it in lower case if you are unsure where it came from.

The Bridge button stays grey, reading "Check the destination", until the address passes. Once it does, a line under the row reads "Not your wallet. Check the address." whenever it differs from your wallet, and the review marks it "(not your wallet)". Locking the row again drops the typed address.

The same address on the other chain may belong to someone else, or to nobody. This matters most for a contract wallet: check that it exists on the destination chain. Test with a small amount first.

## A link that fills in the form

A link to the Bridge screen can carry the direction, the token and the amount; these are filled in quietly. When a link also fills in anything that changes where the tokens go or what you pay, such as the destination, the fee settings, the relay router, the call gas or a call, the screen names those fields in a warning. The review names them again. Check them before you confirm.

## Advanced: a call after delivery

The delivery menu (tap the fee) has an **Advanced** part.

- **Call after delivery.** A contract on the destination chain that the delivery router calls once it has paid the recipient, and the call data to send it. The call comes from the router. It sends no coin. It runs only after the payment succeeded, and a call that fails does not undo the delivery: the recipient keeps the tokens.
- **Call gas.** The exact gas the call gets, as a whole number. It has no default: enter it when you name a call. The callback gas that the transfer carries is worked out from it (the call gas plus the router's own work) and shown beside it, read only. A plain transfer has no gas number at all.

A call costs gas, so a gas-based fee rises with it. The control names the call, its gas and the router, for example "A bot delivers it on PulseChain · fee 0.39%, then calls 0x12…ab with 200,000 gas".

## The allowance

A token contract lets the mediator take your tokens only after you approve it. This approval is the allowance. When your allowance is lower than the amount, the app asks for an approval first, then sends the transfer. Both transactions show in full before your wallet opens. The app asks only for the amount you send.

## What arrives

What arrives is the amount less the fee. The Bridge screen shows it under the delivery control, in the token and in dollars, before you sign. When the fee is still being worked out, it says "estimating".

## When the receiver cannot take the tokens

A delivery can fail for the receiver. A token can, for example, block an address that is on a deny list. The bridge then records the failed release and stops. The message still counts as delivered: the bridge never runs it twice.

A failed release is final. The tokens stay in the mediator. There is no claim and no fallback address, and nothing pays them out later. The page of the message shows a Release row that says so.
