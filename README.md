# Keel

**Event Contract markets that open already quoted.**

Somnia × DreamDEX Event Contracts Hackathon entry. Shannon testnet, chain `50312`.

---

## The problem, measured

Two numbers, both regenerated live by `npm run chainstate` against public endpoints
with no wallet and no key:

- **89.0% of 21,883 DreamDEX binary markets have never traded once.**
- **32 of the 34 assets the Somnia oracle publishes a price for have no Event
  Contracts at all.**

An Event Contract with no maker is a page with two empty sides. The first person to
arrive cannot trade — not at a bad price, at *any* price — so they leave, and the
market that was created to attract them never gets a second visitor. Listing is not
the bottleneck. Being quoted on arrival is.

### One premise we started with turned out to be false, and we are keeping it visible

The original design assumed those empty books meant no market maker to compete with.
Live measurement on 2026-09-01 found every live BTC and ETH window two-sided, with
one incumbent churning 400–550 orders per 4-minute window. Two independent back-test
runs, with every designed defence switched on, **lose money against it at every
parameter tested**. `docs/MM-BACKTEST.md` has the diagnostic: 45.0% of that
incumbent's trades print inside our fair value, at a median edge of 0.0150.

So Keel does not compete for BTC/ETH flow, and nothing in this repo pretends
otherwise. Keel's edge exists only where it is the sole maker — **on the markets it
launches itself**, on the 32 assets nobody has listed.

---

## What Keel is

Two surfaces on one engine.

**Launch** — `contracts/src/KeelFactory.sol`. Anyone can open a rolling Event
Contract series on any oracle-fed asset that has none. Permissionless, and priced:
the caller attaches the oracle reserve the series will spend minting its windows, so
a launch buys the series a runway rather than a single market.

**Underwrite** — `contracts/src/KeelVault.sol`. An epoch vault that manufactures
complete sets and rests both sides of the books Launch opens. Depositors get shares;
the vault gets a spread; the market gets a quote on arrival.

The join between them is a single invariant. Minting a complete set turns one unit of
collateral into one Up **and** one Down, which are worth exactly one unit together no
matter how the window resolves. So if both legs are sold for more than one unit
combined, the outcome cannot touch the vault:

```
askUp + askDown  >=  1 + 2 * minSpread
```

The vault computes both prices on-chain from a fair value and enforces that before
either order is placed — including on the prices after they are snapped to the tick
grid, because rounding is where a markup quietly disappears.

---

## Run it

```bash
npm run setup      # fresh clone -> ready. Idempotent. Deps, pinned Solidity libs, .env, doctor.
npm test           # 85 Node tests + 98 Foundry tests
npm run doctor     # environment check; prints an exact fix line per failure
```

Nothing above needs a wallet, a key, or funds.

```bash
npm run web        # the Keel console at localhost:5173 — live coverage gap and live pricing
npm run chainstate # regenerate the market-structure evidence above (network, read-only)
npm run backtest   # Brier score vs a flat-0.5 baseline (network, read-only, slow)
npm run mmbacktest # reproduce the negative market-making result
npm run quote      # the live quoter loop, dry run by default
```

```bash
npm run deploy               # prints the plan and stops
npm run deploy -- --confirm  # sends it. Needs a funded DEPLOYER_PRIVATE_KEY.
npm run launch -- SOL 300 --confirm   # open a rolling series on an uncovered asset
```

Node 20+ (developed against v24), ESM throughout, npm workspaces. Foundry with
`via_ir = true` — the vault does not fit on the stack without it.

### The console

`npm run web` serves a page that imports `worker/pricer.js` and
`worker/spreadPolicy.js` **directly**. The prices it shows are produced by the same
two modules the back-test scores and `contracts/src/lib/SpreadPolicy.sol` mirrors
line for line, so the demo cannot drift from the contract. It shows the live coverage
gap, and for every open window: the strike reconstructed from oracle ticks, σ trained
only on ticks from before that window opened, the fair value, and the two asks Keel
would rest — with the load line showing how far the pair clears par.

---

## How it is kept honest

**Prices are computed on-chain, not accepted.** The quoter key supplies a fair value
and a size; the contract derives the prices. A stolen hot key can quote badly. It
cannot quote at a structural loss, and it cannot withdraw at all.

That last clause was **not true until a security review found the hole**, and the way
it was untrue is worth keeping in view. `registerPool` ends in an unlimited approve of
the vault's collateral to the pool. While the pool's own `getBinaryPoolParams()` was
the only source of truth, the quoter could deploy a contract that names the real
collateral, register it, take an infinite allowance and drain the vault — without ever
touching the pricing rails the design was built to defend. Provenance now comes from
`module.markets(marketId)`: the pool address, the collateral and the originating venue
must all match, and the outcome ids come from that same trusted answer.

**Share price is struck only when the vault is flat.** Marking a half-filled book
means marking positions, and anything markable is gameable. Deposits and redemptions
queue; `rollEpoch` reverts unless every order is dead and every position redeemed, at
which point net asset value is just the collateral balance. There is no mark to game.

**The exit never touches the operator.** Orders expire with the window, expired
escrow is reclaimable by anyone, settled positions are redeemable by anyone, and
`rollEpoch` is permissionless. `test_depositorCanExitWithoutTheQuoter` is that
guarantee written as a test: the quoter goes dark mid-window and a depositor drives
the whole exit alone.

**Launch cannot be griefed.** Series ids are allocated by the factory and never
reused, because `registerSeries` upserts and would otherwise hand a caller a switch
that silently kills a running series. A duplicate `(asset, interval, collateral)`
reverts naming the incumbent. A malformed ticker reverts rather than registering a
series that mints windows and resolves none of them.

**No owner path moves value.** Not in the vault, not in the factory. The only sweep
on either is permissionless and returns funds to where they already were.

---

## Layout

```
contracts/src/
  KeelFactory.sol            operator + venue + market creator; permissionless launch
  KeelVault.sol              the epoch underwriting vault
  lib/SpreadPolicy.sol       fair value in, two asks out, invariant enforced
  interfaces/                verified signatures and selectors, with citations
worker/
  pricer.js                  P(Up) = Phi((S - K) / (sigma_S * S * sqrt(tau)))
  spreadPolicy.js            line-for-line mirror of the Solidity policy
  quoter.js                  the live loop; the deciding half is pure and tested
  backtest.js                Brier score against a flat-0.5 baseline
  marketmaker.js  mmbacktest.js   the honest fill model and the negative result
web/                         the console
scripts/                     setup, doctor, chainstate, deploy, serve
docs/
  status.html                the living manifest (published as an Artifact)
  SDK-0.29.0-VERIFIED.md     every SDK claim, with file-and-line citations
  SECURITY.md                role split, nineteen threats, tagged built/planned/accepted
  MM-BACKTEST.md             why competing for BTC/ETH flow does not work
```

`worker/spreadPolicy.js` and `contracts/src/lib/SpreadPolicy.sol` are tested against
the same reference values. **Change both or neither** — the whole point is that the
simulation and the chain cannot drift apart.

---

## Status

**Keel is deployed and running on Shannon.** It stood up its own operator, venue,
market creator and creator-allowlist — DreamDEX's venue allowlists creators, so there
was no other way to list anything — and has launched rolling series that its own
market creator minted and the Somnia oracle settled without anyone touching them.

`docs/status.html` is the current manifest: live addresses, what is measured, what is
built, and what is still open.

MIT.
