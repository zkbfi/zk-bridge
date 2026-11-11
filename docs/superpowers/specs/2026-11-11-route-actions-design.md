# Route actions: anyone moves the route forward from the dapp

Owner, 2026-11-11, verbatim:

> the point is to allow the user to write all of this stuff. can't we have the user post the needed proof?

> you should make them all yes in the dapp. our ui should show the situation / constraints of each situation and then
> guide the user through making it happen (using our backend + gpu to create proofs)

Earlier the same day: "lets assume that everything will flow through the backend for now. gpu is available. treat it
the same."

## Intent

Every on-chain step the route needs is permissionless. Today most of them are posted only by our backend and runner.
The dapp should let any visitor do each one: see what is pending and what limits it, have our backend make the proof
(on the GPU where one is needed), and post it from their own wallet. Our backend and runner stay as the poster of last
resort, after a deadline, so the route keeps moving on a quiet day.

## The steps (all get a button)

| Step | Proof made by | Posted by the user's wallet | Today in the dapp |
|---|---|---|---|
| Light-client update, each direction | backend, GPU (SP1) | `update(proof, publicValues)` on the destination light client | no (request a proof exists; posting no) |
| Open deposits on a new bridge | backend (opening proof, no GPU) | `openDeposits(...)` | no |
| Layout rows before a delivery | backend (beacon data, no GPU) | the `add...Layout` calls | inside delivery only |
| Deliver a message | backend evidence (no GPU) | `executeMessage(proof)` | yes |
| Fork observation (PulseChain) | backend, GPU (SP1) | `ForkRegistry.observe` | yes (2026-11-11) |
| Seal a gate | Ethereum: Merkle evidence from a beacon node; PulseChain: from the registry | `seal(evidence)` | yes |
| Update the fork registry's own light client (PulseChain) | backend, GPU (SP1) | `update(...)` on that light client | no |

## For each step the dapp shows

1. **The situation**, in numbers: what is pending and for how long (for example "PulseChain's light client on Sepolia
   is 19 h behind; 3 transfers wait for it; it strands in 8 h"), from the backend's pipeline, stranding and fork reads.
2. **The constraints**, in numbers, before the user commits:
   - when the proof can be made (finality: "the block becomes final at 14:32 UTC");
   - GPU time and queue ("about 1 min on a warm worker; 3 to 7 min if a worker has to start"), and the day's GPU budget
     left for that direction;
   - one job per finality (if a proof for this finality is already being made, the user joins it instead of starting
     another);
   - the gas of the posting transaction and its cost at the current fee;
   - whether someone else already posted it (then the step is done and the button goes away).
3. **The guided flow:** "Make the proof" (backend job, progress shown) → "Post it from your wallet" (the normal review
   dialog) → "Done" with the transaction. If the backend or runner posts first, the dapp says so and stops.

## Where it shows

- **Explore, "Route" section:** every pending step for both directions, each with its situation, constraints and
  button. (my call, see below)
- **A transfer's progress view:** the one step that blocks this transfer, with its button, in the timeline under the
  stage it waits on.
- **Bridge screen:** a one-line notice when a step blocks new sends or deliveries (deposits closed, gate sealed, light
  client near stranding), linking to the Explore section.
- No sign-in. A wallet is needed only to post.

## Backend

- One generic way to ask for a proof: request a job of a kind for a direction (light-client update, registry update,
  fork observation; opening, layout and delivery evidence need no GPU and are built on request). The existing guards
  apply: one job per finality, the daily GPU budget per direction, the per-caller rate limits. A request while a job
  runs joins it.
- Serve each finished proof publicly (public fields only), as the observation route of 2026-11-11 does.
- The backend and runner post a step themselves only when nobody has posted it by its deadline (light-client keep-alive
  before stranding, registry light client before 64 periods, a seal at once).

## Non-goals

- No proving in the browser.
- No new contract: every call above exists and is permissionless.
- No sign-in, accounts or reputation.

## Calls made by the planner (owner may change)

- Placement: Explore "Route" section plus the transfer timeline plus a one-line notice on the Bridge screen.
- The backend's fallback deadlines: light-client keep-alive as today (`keepAliveSeconds` 12 h); registry light client
  every period (about 22.75 h); a seal at once.
