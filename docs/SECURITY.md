# Keel — threat model

Keel holds other people's deposits and lets an automated process place orders with
them. That combination is where the risk lives, so this document names every way
the money can leave incorrectly and says, for each, whether the defence is built,
planned, or deliberately accepted.

Status keys: **built** (in the repo with a test), **planned** (designed, not yet
written), **accepted** (a real risk we are choosing to run, and disclosing).

This is a testnet build. tUSDC and STT have no monetary value. That lowers the
stakes but not the standard — the code is written as if it did.

## Roles and what each may do

| Role | Holds | May do | May never do |
|---|---|---|---|
| Owner | Deployer key, cold | Set policy, pause, upgrade the quoter address | Withdraw depositor funds |
| Quoter | Bot key, hot on a server | Mint sets, post and cancel quotes, redeem, roll | Withdraw, set policy, change owner |
| Depositor | Their own wallet | Deposit, withdraw their shares | Touch anyone else's shares |
| Taker | Their own wallet | Fill Keel's resting orders | Anything else |
| Launcher | Their own wallet, and the launch fee | Open a series on any uncovered asset, refuel a starving creator | Choose the series id, launch a duplicate, take the float back |

The split that matters: **the hot key cannot move money out.** A server
compromise costs bad quotes within the policy band, not the vault.

## Threats

### T1 — Hot quoter key stolen
An attacker with the bot key posts deliberately terrible quotes and takes the
other side themselves, draining the vault through the order book rather than
through a withdrawal.

*Defence (built):* `SpreadPolicy` enforces `askUp + askDown >= 1 + 2·minSpread`
on every quote, in Solidity, at the point of use. Selling a complete set below
what minting it cost reverts. The attacker's best case is capturing less markup
than intended, not extracting principal.
*Defence (planned):* per-window notional cap as a fraction of NAV, and a
per-block quote-update rate limit, so a stolen key cannot commit the whole vault
to one window.

### T2 — Owner key stolen
*Defence (planned):* the owner cannot call any withdrawal path at all; the
capability does not exist in the contract rather than being access-controlled.
Policy changes go through `SpreadPolicy.validate`, so even an attacking owner
cannot configure the solvency invariant away. A timelock on policy changes is the
obvious next step and is **accepted** as absent for a nine-day build.

### T3 — ERC-4626 first-depositor share inflation
The classic attack: deposit dust, transfer a large amount of collateral straight
to the vault so it lands in NAV without ever being a queued deposit, and every
subsequent depositor rounds down to zero shares.

For most of this build we believed the epoch design already closed this — the
share price is a constant at zero supply, so there was nothing to inflate. **A
security review on 2026-09-03 showed that was wrong.** Zero-supply pricing only
protects the roll in which supply leaves zero. The working attack takes two rolls:
the first leaves the attacker holding a one-wei supply against a large donated
NAV, and the second strikes a price so high that an honest depositor's shares
floor to zero, leaving their collateral behind as backing for the attacker's
single share. No privileged role is needed — `requestDeposit`, `requestRedeem` and
`rollEpoch` are all permissionless by design.

*Defence (built):* `DEAD_SHARES` (1e3) minted once to an address with no key, at
the first roll that issues any shares, plus a `MIN_DEPOSIT` floor. The dead shares
are the supply the attacker cannot own: to floor a victim's deposit to zero they
must now donate more than a thousand times it, and forfeit almost all of that
donation to shares nobody can redeem. `test_shareInflationAttackLosesMoneyForTheAttacker`
runs the whole sequence and asserts the victim keeps real shares and the attacker
ends poorer. Cost to honest users: 1000 wei, once, paid by the first depositor.

### T3a — A forged pool turns the quoter key into a withdrawal key
`registerPool` ends in an unlimited `approve` of the vault's collateral to the
pool. While the pool's own `getBinaryPoolParams()` was the only source of truth,
the quoter could deploy a contract that reports the vault's real collateral
address, call `registerPool` on it, receive an infinite allowance and
`transferFrom` the entire balance — queued deposits and reserved redemptions
included. This was the most serious finding of the review: it made the headline
claim of the whole design ("a stolen hot key can quote badly, not ruinously")
false, and it worked by never touching the pricing path the design defends.

*Defence (built):* provenance is read from `module.markets(marketId)` — the
module being immutable in the vault and the one contract it has no choice but to
trust. The pool address, the collateral and the originating venue id must all
match, and the outcome ids are taken from that same trusted answer rather than
from the pool. Four tests cover it, including one that runs the forged pool and
asserts no allowance was ever granted.

### T3b — A hostile quoter blocks `rollEpoch` indefinitely
The documented worst case for a lost quoter key was "wait out one window". That
holds for a key that goes silent. A key that is actively hostile is different:
`mintSets` had no tie to a window's lifecycle, so the attacker could keep minting
fresh sets with the vault's own collateral — no capital of their own, only gas —
and `rollEpoch` refuses while any pool is active. Every deposit and redemption
would be frozen until the owner rotated the key.

*Defence (built):* `mintSets` reverts once the window has expired. Positions it
opens now die on a clock the quoter does not control, and once they do, anyone can
`reclaimExpired`, `burnSets` and `rollEpoch`.

### T4 — Adverse selection against a stale quote
Anyone reading the same oracle a beat sooner can lift a quote that has not been
refreshed. This is a genuine cost, not a bug.

*Defence (built, partial):* the markup widens as `sqrt(refTau/tau)`, which is the
same shape as fair value's sensitivity to spot, so the quote is widest exactly
when a stale price is most expensive.
*Defence (planned):* re-quote on the oracle tick; mandatory order expiry as a
dead-man's switch, so a dead quoter's orders fall off the book rather than
sitting there stale.
*Accepted:* it cannot be eliminated. It is measured in the back-test rather than
assumed away, and it belongs in the write-up.

### T5 — One-sided fill leaves directional exposure
A taker buys only the Up leg. The vault now holds a Down position it did not want
and the window's outcome starts to matter to it. This is the strategy's real risk.

*Defence (built):* the skew term charges more for adding to a side already held.
*Defence (planned):* cap size per window as a fraction of NAV; `burnSet` back to
par when neither side fills; let a leftover leg ride to expiry and redeem.
*Accepted and disclosed:* a run of one-sided fills against the vault is a losing
sequence. The back-test exists to size that risk rather than deny it.

### T6 — Off-chain fair value is wrong or manipulated
The quoter computes fair value off-chain and hands it to the vault. A wrong number
is a wrong quote.

*Defence (built):* the vault treats fair value as untrusted input — it is bounded
into `(0, 1)` and every quote derived from it must still clear the solvency
invariant, so no fair value produces a set sold below par.
*Defence (planned):* sanity-check the submitted value against the on-chain mark
and reject a quote whose implied spot is implausibly far from it.

### T7 — Pool address recycling attaches state to the wrong window
DreamDEX reuses the same pool address across windows; some have rolled more than
1,800 generations. Any state keyed by address will silently bind to a later
window.

*Defence (planned, and a hard rule):* key every mapping by `marketId`, never by
pool address. To be enforced by a test that two successive windows sharing an
address keep separate accounting.

### T8 — The SDK reports success on a reverted write
Reported against 0.28.x: the SDK skipped simulation and resolved normally even
when the transaction reverted, silently breaking bots that trusted the resolve.

*Defence (planned):* assert on `receipt.status` around every write, from the first
one. Behaviour in 0.29.0 is being verified from source rather than assumed; see
`docs/SDK-0.29.0-VERIFIED.md`.

### T9 — Voided settlement
A window can be voided, paying both sides 0.5 rather than 1 and 0.

*Defence (planned):* NAV accounting must treat a voided market as a complete set
at par, which is what it becomes. A demo must never depend on a single live
window; record the settlement lap separately with a clean backup take.

### T10 — Withdrawal timed against a favourable mark
NAV includes leftover single-sided inventory marked at model fair value. A
depositor who withdraws while that mark is generous takes value from whoever
stays.

*Defence (planned):* mark leftover inventory conservatively — at the worse of
model value and the book's live bid — so the mark cannot be gamed in the
withdrawer's favour.
*Accepted:* with a single-digit number of depositors on a testnet this is a
theoretical concern; it is written down because it stops being theoretical the
moment anyone else deposits.

### T11 — Gas exhaustion stops the quoter
STT from a faucet is the scarce resource, and a re-quoting bot burns it. A quoter
that runs dry stops refreshing, and stale quotes are exactly what T4 punishes.

*Defence (built):* `npm run doctor` reports the gas balance of both wallets and
fails below a floor.
*Defence (built):* `planWindow` requotes only when fair value has moved past a
threshold or tau has moved enough to change the widening, so the loop does not
burn gas restating the same quote (`worker/test/quoter.test.js`).
*Defence (built):* mandatory order expiry means a dead quoter's book empties
itself rather than going stale.

### T12 — A permissionless launch drains the creator's native float
Every market creation attaches `resolveReserve()` in native value, spent out of
the MarketCreator's own float. If launching were free, the first caller could open
a hundred series and stall every one already running — including other people's.

*Defence (built):* `KeelFactory.launch` is payable and priced off the hub's live
`resolveReserve()` times `rollsPrefunded`, so the launcher funds the runway their
own series will consume. The price is read at call time rather than stored, so a
protocol-side reserve change cannot leave it stale.
*Defence (built):* `refuel()` is permissionless, because a starved creator stalls
every series it runs and anyone holding those positions has reason to fix it.
*Accepted:* a launcher can still overpay, and the surplus stays in the shared
float rather than being refundable to them. It funds rolls, which is what it was
attached for.

### T12a — A fast series starves every other series' float
All series draw on one shared creator float. `launchCost` was a flat roll count,
so a 60-second series paid exactly what a 7-day series paid while consuming the
float 10,080 times faster. Anyone could launch cheap short-interval series and
starve the honestly funded ones behind them.

*Defence (built):* `launchCostFor(intervalSec)` prices a launch by the runway it
buys, not by a roll count — a launch pre-pays for `runwaySec` of wall-clock life
at its own cadence. `MAX_PREFUNDED_ROLLS` caps the charge at the very short end,
which leaves a bounded advantage there — roughly 2x rather than four orders of
magnitude — and `refuel` is permissionless for the rest. **Accepted**, and stated
rather than hidden.

### T12b — A stranded roll loop cannot be restarted
Measured live on 2026-09-02: a reactivity callback whose gas budget is too small
strands the series. The last market settles normally, no next one is minted, and
`armedBoundary` still reads as the dead market's expiry, so nothing on-chain looks
wrong. `triggerRoll` is owner-only on the creator and the factory is that owner,
so there was no way back at all.

*Defence (built):* `KeelFactory.rearm(seriesId)`, permissionless for the same
reason `refuel` is, plus a `DEFAULT_ROLL_GAS_LIMIT` of 120,000,000 set at
bootstrap — a roll costs a measured 64,387,607 gas, and the previous default of
3,000,000 is what stranded the live series in the first place.

### T13 — A caller names a series id and silently kills a live series
`registerSeries` upserts by id **and resets that series' oracle reference**. An id
a caller can choose is a switch that quietly stops a running series mid-flight,
leaving positions open against a market that will never roll again.

*Defence (built):* the id space is a monotonic counter inside the factory. No
caller-supplied id reaches `registerSeries`, and
`test_seriesIdsAreAllocatedMonotonicallyAndNeverReused` asserts each id is
registered exactly once.
*Defence (built):* a duplicate `(asset, interval, collateral)` reverts naming the
series that already exists, rather than burning reserve to split one book in two.

### T14 — A malformed ticker registers a series that never resolves
The asset string doubles as the base symbol the oracle's candle sources look up on
the exchanges, and there is no on-chain allow-list of tickers. A pair, a lowercase
symbol or a perp suffix registers cleanly, mints windows on schedule, and settles
none of them — the failure is invisible until expiry.

*Defence (built):* `launch` rejects anything that is not plain uppercase
alphanumeric and at most sixteen characters, turning a silent dead series into a
revert the caller can read.
*Accepted:* a well-formed ticker for an asset the sources do not list still fails
this way. Only the oracle knows its own catalogue, and it is not on-chain.

### T15 — A half-run bootstrap orphans an operator and a venue
Registering the operator, creating the venue, minting the creator and allowlisting
it are four calls. Stop after the third and the venue reads as live and refuses
every roll; the operator and venue already spent are not reclaimable.

*Defence (built):* `bootstrap` does all four in one transaction, asserts
`policy.approved(creator)` before it returns, and reverts `AlreadyBootstrapped` on
a second attempt.
*Defence (built):* the venue is created with `signer = 0`. A non-zero venue signer
demands a signature per market creation, and an automated roll loop cannot produce
one — the series would look configured and never mint.

## Secrets

- `.env` is gitignored and is the only place a key belongs. `.env.example` ships
  with the fields empty.
- Keys are read from the environment and never logged. `doctor` prints derived
  addresses and balances, never key material.
- Use throwaway keys with no mainnet history. The repo says so in three places
  because people paste real keys into hackathon repos every single time.
- Before any recording or screen share: check that no terminal pane has a key in
  its scrollback.

## What is not defended

- No formal verification, no external audit. Nine days.
- No timelock on owner actions.
- No upgrade path. The contracts are immutable once deployed; a bug means a
  redeploy and a migration, which on a testnet is acceptable and on a mainnet
  would not be.
- Keel being the only maker on the markets it launches is disclosed as a fact
  about the product, not defended against. A judge who finds an undisclosed house
  maker reads it as dishonesty; one who is told up front reads it as the design.
