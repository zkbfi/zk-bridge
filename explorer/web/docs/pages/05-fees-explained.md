# Fees explained

You can pay two kinds of fee. The bridge fee goes to the fee recipient and follows a fixed schedule. The tip for delivery is voluntary and pays a runner for the delivery. This page explains both.

## The bridge fee

The bridge fee falls with time. It has no administrator. No person can change the rate after deployment.

The fee is charged on PulseChain only. Ethereum charges no fee.

PulseChain charges the fee in both directions. It takes the fee when you send tokens from PulseChain. It also takes the fee when tokens arrive on PulseChain. So each one-way transfer pays the fee once. A round trip pays it twice.

## The schedule on PulseChain

The rate starts at 0.10 percent in the first year. It falls by 0.01 percentage point each year. It stops at 0.05 percent from year six on. Each year lasts 365 days.

| Year | Rate |
|---|---|
| 1 | 0.10% |
| 2 | 0.09% |
| 3 | 0.08% |
| 4 | 0.07% |
| 5 | 0.06% |
| 6 and later | 0.05% |

The count starts at the timestamp of the block that deployed the token mediator. Rates are fixed at deployment in the contract.

## An example

You bridge 1,000 USDC while the rate is 0.10 percent. The fee is 1 USDC. The recipient gets 999 USDC.

| Rate | Fee on 1,000 USDC |
|---|---|
| 0.10% | 1.00 USDC |
| 0.09% | 0.90 USDC |
| 0.08% | 0.80 USDC |
| 0.07% | 0.70 USDC |
| 0.06% | 0.60 USDC |
| 0.05% | 0.50 USDC |

The contract rounds the fee down to the smallest unit of the token. The fee never exceeds the amount.

## The rate you read is the highest you can meet

The rate only falls. It never rises. So the rate you read before you send is the highest rate that your transfer can meet.

A transfer from Ethereum to PulseChain pays the rate at delivery. This rate can be lower than the rate you read, never higher. For this reason, the bridge needs no maximum fee in your message.

## Who gets the bridge fee

The fee stays in the mediator as an accrued balance. The fee recipient is set at deployment and cannot change. Anyone can call the collection function, and it sends the balance to the recipient. The fee has no authority over your funds.

## The tip for delivery

A runner delivers a covered transfer when the tip pays for the work. The interface turns the tip on by default. The default is 0.1 percent of the transfer, in the percentage mode. You can edit the tip, change its mode, or remove it with the choice "No tip".

You fix the tip when the transfer leaves. Nothing at delivery sets or changes it. The runner supplies no rate.

The interface sends your tokens to a router on the destination chain, with `relayTokensAndCall`. The router is the receiver of that call. Your tip settings travel in the call data. When you choose "No tip", the interface involves no router at all. It sends a plain relay (`relayTokens`, or `relayTokensWithFallback`) with no fee terms, and the tokens go straight to the receiver. No router and no runner can take a fee. Anyone can still deliver the message directly on the bridge, for free, but it may take longer. The confirm dialog says that no router is involved.

## Who can collect the tip

Only one whitelisted runner can collect tips through a router. The fee router of a deployment names exactly one runner when it is deployed. No owner can change it. Any other account that calls the router fails.

The router pays the tip to that runner, and only when that runner delivers the message through the router. The runner takes the tip from your tokens. The recipient gets the rest.

## A direct delivery pays no tip

The bridge stays open to everyone. Anyone can call the bridge directly to deliver your message. This is a direct delivery. A direct delivery records no runner, so the router pays no tip. The recipient gets the whole amount. A direct delivery costs you nothing. It only means that nobody is paid.

## When the transfer cannot carry a tip

Two cases cannot carry a tip. In both cases the interface sends a plain relay and tells you why on the form.

- The wrap route. It wraps the native coin and relays it in one call. This call has no call data, so it has no place for the tip.
- A destination chain with no fee router in the deployment.

## The router field

The form has an advanced field named "Router". It starts with the fee router of the deployment on the destination chain. You can name another router. The confirm dialog shows the router address. It marks a router that is not the fee router of the deployment. The tip settings are written for the fee router. Another router can read them in a different way. Use it only if you trust it.

## The modes

The form offers these modes. Each one has a label that tells you how sure the amount is.

### Percentage

You pay a share of the transfer value. The default is 0.1 percent. You can type another share. The amount is exact. The label reads "exact". This mode needs no price.

### Fixed

You pay a fixed amount, in whole tokens. If you leave the amount empty, the form suggests one that covers the cost plus a margin. The suggestion needs your coin price. The amount is exact.

### Gas multiplier with a ceiling

You pay for the gas that the delivery uses, times a multiplier. The tip follows the gas price at delivery. A ceiling limits it. This mode works for any token.

The amount is an estimate. The label reads "estimate, at most X". X is the ceiling, in the units of your token. The default suggestion uses a multiplier of 1.2. It sets the ceiling at the tip for twice the base fee of now.

### Your coin price

The gas multiplier needs a price: how many tokens one native coin of the destination chain is worth. The field "Your coin price" holds it. The price is your own. The page cannot verify it, and nothing at delivery reads it. The interface folds the price into the multiplier when the transfer leaves. For the wrapped native token, the field starts at 1. For another token, you type it.

## What exact and estimate mean

Exact means the fee is known to the smallest unit before you sign. Estimate means the real fee can differ. An estimate never goes above the stated maximum.

The maximum the runner can take is shown before you sign. Check this number. It is the most you can pay in tip.

## The cost breakdown

The form shows three lines when it knows your coin price. Every line is an estimate.

- Gas cost: the delivery gas, times the base fee plus the priority fee.
- Proof cost: a share of the cost of one proof.
- Margin: the tip minus the other two lines. This is the runner's profit.

The suggestion for the fixed amount uses a margin of 10 percent by default. A margin of zero covers the cost and nothing more. A runner that requires a margin above zero skips such a tip.

The proof cost comes from a price in US dollars set by the operator. The default is 0.02, the measured cost of one warm proof. The indexer converts it with a configured price of the native coin. If no price is set, the form leaves the proof cost out and says so.

## The data source line

Each suggestion shows where its gas figure comes from. You see one of two lines.

- "measured from N recent deliveries, p90": the indexer measured N real deliveries. It uses the 90th percentile of their gas.
- "default, no deliveries measured yet": no delivery is measured. The indexer uses a configured default of 550000 gas.

The default is a computed figure, not a measurement. The figures improve by themselves as the indexer records more deliveries.

## Base fee time

The form also shows the base fee that it used. It names the block and the time of that block. For example: base fee 7 gwei at block 12.

The base fee changes from block to block. Check the time. An old base fee gives a weak estimate.

## Payout

For the wrapped native token, you can ask the router to pay the runner in the native coin. This option unwraps the token first. For every other token, the router pays the tip in that token.
