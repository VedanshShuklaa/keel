# `@somnia-chain/markets-sdk` 0.29.0 — Verified API Reference (for Keel)

Every claim below is sourced. Citations are to files under
`node_modules/@somnia-chain/markets-sdk/` (the package ships full TypeScript
`src/`, which is what was read — `dist/` is the compiled twin) or to a live
read-only `eth_call` / indexer query executed on 2026-09-01 against
`https://dream-rpc.somnia.network` (chain id `0xc488` = **50312**, verified via
`eth_chainId`) and `https://dev.smk.somnia.host/v1/graphql`.

Anything I could not confirm from source or a read-only call is marked
**UNVERIFIED**.

> Comparison baseline for §9: `0.28.1` was downloaded from the npm registry
> (`markets-sdk-0.28.1.tgz`) into a scratch dir and diffed against the installed
> `0.29.0`. The package ships **no CHANGELOG** (`ls` of the package root shows
> only `dist/`, `src/`, `LICENSE`, `README.md`, `package.json`).

---

## 0. The one table that matters — JS method → on-chain call

`KeelVault` is Solidity and cannot use the JS SDK. This is the mapping. All
selectors were computed with viem's `toFunctionSelector` from the exact ABI
strings cited.

| SDK method | Target contract | On-chain function signature | Selector | Source |
|---|---|---|---|---|
| `trader.mintSet` | **BinaryPool** (per market) | `mintSet(address yesTo,address noTo,uint256 amount)` | `0x54657dd2` | `src/binary/sets.ts:6-19`, `src/tradeAbi.ts:66` |
| `trader.burnSet` | **BinaryPool** | `burnSet(uint256 amount)` | `0x55664dbd` | `src/binary/sets.ts:21-36`, `src/tradeAbi.ts:69` |
| `trader.placeOrder` (binary) | **BinaryPool** | `placeBinaryOrder(uint8 kind,uint256 price,uint256 quantity,uint64 expireTimestampNs,uint8 orderType,uint8 selfMatchingOption,address builder,uint96 builderFeeBpsTimes1k,uint64 userData) payable returns (bool,uint128)` | `0x718c2d4d` | `src/orders.ts:1035-1071`, `src/tradeAbi.ts:32` |
| (operator-placed) | **BinaryPool** | `placeBinaryOrderFor(address owner,uint8 kind,…same tail…) payable returns (bool,uint128)` | `0x5d97c566` | `src/tradeAbi.ts:33` |
| `trader.cancelOrder` | **BinaryPool** | `cancelOrder(uint128 orderId)` | `0xdbc91396` | `src/orders.ts:1089-1097`, `src/tradeAbi.ts:34` |
| `trader.cancelOrders` | **BinaryPool** | `cancelOrders(uint128[] orderIds) returns (bool[])` | `0x0dce6933` | `src/tradeAbi.ts:138` |
| `trader.reduceOrder` | **BinaryPool** | `reduceOrder(uint128 orderId,uint256 newQuantityRemaining)` | `0x33407b60` | `src/orders.ts:1099-1107`, `src/tradeAbi.ts:41` |
| `trader.cancelExpiredOrders` | **BinaryPool** | `cancelExpiredOrders(uint128[] orderIds)` | `0x2f2461cd` | `src/tradeAbi.ts:48` |
| `trader.sweepExpiredAtLevel` | **BinaryPool** | `sweepExpiredAtLevel(bool isBid,uint256 price,uint256 maxCount) returns (uint256)` | `0x9362798d` | `src/tradeAbi.ts:49` |
| `trader.captureClose` | **BinaryPool** | `captureClose(uint256 maxSteps)` | `0x2147084b` | `src/tradeAbi.ts:55` |
| `trader.approveBuilder` | **BinaryPool** | `approveBuilder(address builder,uint256 maxFeeBpsTimes1k)` | `0x605e0222` | `src/fees.ts:357-365`, `src/tradeAbi.ts:58` |
| (auto, inside `mintSet`/buy orders) | **collateral ERC-20** | `approve(address spender,uint256 amount) returns (bool)` | `0x095ea7b3` | `src/writer.ts:787-803`, `src/tradeAbi.ts:11` |
| (auto, inside `burnSet`/sell orders/`redeem`) | **ERC-6909 outcome singleton** | `setOperator(address spender,bool approved) returns (bool)` | `0x558a7297` | `src/writer.ts:815-830`, `src/readsAbi.ts:153` |
| `trader.redeem` | **BinaryMarketsModule** | `redeem(uint32 operatorId,bytes32 venueId,bytes32 marketId,uint8 outcomeIdx,uint256 amount)` | `0x5b1ffcf2` | `src/binary/settlement.ts:37-84`, `src/moduleAbi.ts:20` |
| `trader.redeemMany` | **BinaryMarketsModule** | `redeemMany(uint32,bytes32,bytes32[],uint8[],uint256[])` | `0x88cb9474` | `src/binary/settlement.ts:167-188`, `src/moduleAbi.ts:21` |
| `trader.redeemDirect` | **BinarySettlement** | `redeem(uint256 outcomeId,uint256 amount,address to) returns (uint256)` | `0x049104e5` | `src/binary/settlement.ts:190-207`, `src/readsAbi.ts:90` |
| `trader.claimOwed` | **BinarySettlement** | `claimOwed(address token) returns (uint256)` | `0x798a6ca5` | `src/binary/settlement.ts:209-217`, `src/readsAbi.ts:93` |
| `trader.finalizeMarket` | **BinaryMarketsModule** | `finalizeMarket(bytes32 marketId)` | `0x626cb257` | `src/binary/settlement.ts:219-227`, `src/moduleAbi.ts:30` |
| `trader.releasePool` | **BinaryMarketsModule** | `releasePool(bytes32 marketId)` | `0xda8a1461` | `src/moduleAbi.ts:31` |
| `trader.syncSettlement` | **BinaryMarketsModule** | `syncSettlement(bytes32 marketId)` | `0x687d0a78` | `src/moduleAbi.ts:37` |
| `trader.pokeOracle` | **BinaryMarketsModule** | `pokeOracle(uint256 oracleQuestionId)` | `0xbddb5def` | `src/moduleAbi.ts:44` |
| (module route for sets) | **BinaryMarketsModule** | `mintCompleteSet(uint32,bytes32,bytes32 marketId,uint256 amount)` | `0x47dfb781` | `src/moduleAbi.ts:24` |
| (module route for sets) | **BinaryMarketsModule** | `mergeCompleteSet(uint32,bytes32,bytes32 marketId,uint256 amount)` | `0xb6354afe` | `src/moduleAbi.ts:25` |
| `operatorAdmin.registerOperator` | **MarketsCore** | `registerOperator(address feeRecipient,bool enabled,address policy,bytes context) returns (uint32)` | `0xb3012817` | `src/operatorAdmin.ts:346-354`, `src/operatorAbi.ts:11` |
| `operatorAdmin.createVenue` | **MarketsCore** | `createVenue(uint32 operatorId,bytes4 marketType,(bytes,address,address,address,bool,bytes) config) returns (bytes32)` | `0x796e23e1` | `src/operatorAdmin.ts:379-386`, `src/operatorAbi.ts:16` |
| `client.encodeBinaryVenueFeeParams` | **BinaryMarketsModule** | `encodeVenueFeeParams((uint64,uint64,uint64,uint64,uint64,uint8)) pure returns (bytes)` | `0x16899d27` | `src/operatorReads.ts:93-119`, `src/operatorAbi.ts:35` |
| `mcAdmin.createMarketCreator` | **MarketCreatorFactory** | `createMarketCreator(address owner,address core,address adapter,uint32 operatorId,bytes32 venueId,(uint256 tickSize,uint256 minQuantity,uint256 lotSize)) returns (address,address)` | `0x165ca027` | `src/marketCreatorAdmin.ts:496-508`, `src/machineryAbi.ts:127` |
| `mcAdmin.registerSeries` | **MarketCreator** | `registerSeries(uint32 seriesId,(address collateral,string asset,uint64 numericDecimals,uint64 intervalSec,uint64 settlementWindow))` | `0x9360d325` | `src/marketCreatorAdmin.ts:476-494`, `src/machineryAbi.ts:143` |
| `mcAdmin.triggerRoll` | **MarketCreator (v1 only)** | `triggerRoll(uint32 seriesId)` | `0xae3332fa` | `src/marketCreatorAdmin.ts:514-516`, `src/machineryAbi.ts:144` |
| `mcAdmin.armFirstRoll` | **MarketCreator** | `armFirstRoll(uint32 seriesId,uint256 firesAtSec)` | `0xea623a3c` | `src/marketCreatorAdmin.ts:528-530`, `src/machineryAbi.ts:148` |
| `mcAdmin.fundMarketCreator` | **MarketCreator** | plain native transfer to `receive()` | n/a | `src/marketCreatorAdmin.ts:100-107, 327-331` |
| `governanceAdmin.setAdapterApproved` | **BinaryMarketsModule** | `setAdapterApproved(address adapter,bool approved)` | (owner-only, not ours) | `src/machineryAbi.ts:245` |

Reads a Solidity contract will want:

| Purpose | Contract | Function | Selector | Source |
|---|---|---|---|---|
| whole pool state in 1 call | BinaryPool | `getBinaryPoolParams()` → `(address collateralToken,address market,address outcomeToken,uint256 yesId,uint256 noId,uint256 oneCollateral,uint256 setBacking,address feeRecipient,uint256 makerFeeBpsTimes1k,uint256 takerFeeBpsTimes1k,uint256 maxBuilderFeeBpsTimes1k,uint256 settlementFeeBpsTimes1k,address settlement,uint64 marketNonce,bool finalized)` | `0x9b98cc19` | `src/readsAbi.ts:62` |
| tick / lot grid | BinaryPool | `getOrderBookParameters()` → `(uint256 tickSize,uint256 minQuantity,uint256 lotSize)` | `0x0765910c` | `src/readsAbi.ts:36` |
| order-expiry cap | BinaryPool | `marketExpiryNs()` → `uint64` | `0x7e3915e9` | `src/readsAbi.ts:53` |
| book depth | BinaryPool | `getBookLevels(bool isBid,uint64 numLevels)` → `(uint256 price,uint256 quantity)[]` | `0x1ff96521` | `src/readsAbi.ts:33` |
| market record | BinaryMarketsModule | `markets(bytes32)` → `(uint256 oracleQuestionId,uint8 outcomeSlotCount,uint8 voidPolicy,address collateral,uint32 originOperatorId,bytes32 originVenueId,address oracleAdapter,address creator,address market,address pool,uint256 yesId,uint256 noId,uint64 tradingStart,uint64 expiry)` | `0x7564912b` | `src/moduleAbi.ts:94` |
| pool nonce for a market | BinaryMarketsModule | `marketNonce(bytes32)` → `uint64` | `0x9e48ee0b` | `src/moduleAbi.ts:92` |
| payout vector | BinaryMarket | `payoutNumerators()` → `uint256[]` | — | `src/readsAbi.ts:120` |
| settled? | BinaryMarket | `isResolved()` / `isVoided()` | — | `src/readsAbi.ts:121-122` |
| position balance | ERC-6909 singleton | `balanceOf(address owner,uint256 id)` | `0x00fdd58e` | `src/readsAbi.ts:149` |
| settlement record | BinarySettlement | `getSettlement(uint256 marketKey)` | `0x4c582380` | `src/readsAbi.ts:94` |

---

## 1. Complete sets (`mintSet` / `burnSet`)

### SDK surface

* Module path: `@somnia-chain/markets-sdk` → `client.createTrader(cfg)` →
  `trader.mintSet(p)` / `trader.burnSet(p)`. Implementation lives in
  `src/binary/sets.ts:6` and `:21`; params in `src/trade.ts:1332` (`MintSetParams`)
  and `src/trade.ts:1354` (`BurnSetParams`).

```ts
interface MintSetParams {                     // src/trade.ts:1332-1348
  pool: Address;          // BinaryPool address (NOT the market, NOT the module)
  amount: bigint;         // raw collateral units → mints `amount` YES + `amount` NO
  collateral?: Address;   // resolved from pool.collateralToken() if omitted
  autoApprove?: boolean;  // default true
  gas?: bigint;           // default 10_000_000n  (src/trade.ts:68-71)
}
interface BurnSetParams {                     // src/trade.ts:1354-1373
  pool: Address;
  amount: bigint;         // burns `amount` YES + `amount` NO, refunds `amount` collateral
  outcomeToken?: Address; // ERC-6909 singleton; resolved from the pool if omitted
  autoApprove?: boolean;  // default true
  gas?: bigint;
}
```

### On-chain

* `mintSet(address yesTo, address noTo, uint256 amount)` — selector `0x54657dd2`,
  on the **BinaryPool**. Contract comment (`src/tradeAbi.ts:64-66`): *"pool pulls
  `amount` collateral from caller, mints `amount` YES to yesTo and `amount` NO to
  noTo."* The SDK passes `[w.fromAddress, w.fromAddress, p.amount]`
  (`src/binary/sets.ts:16`).
* `burnSet(uint256 amount)` — selector `0x55664dbd`, on the BinaryPool
  (`src/tradeAbi.ts:67-69`). Collateral is *"credited via the pool's vault"* —
  see the vault note below.
* `redeem` is **gone from the pool** in v2 (`src/tradeAbi.ts:70-73`).

### Units

`amount` is raw collateral units. Outcome tokens mirror the collateral's
decimals (`src/markets.ts:74-75`: *"binary: outcome tokens mirror the
collateral's decimals"*), so one integer serves both legs. On Shannon tUSDC that
is 6 decimals → `1_000_000n` == 1 set.

Live verification: `getBinaryPoolParams()` on pool
`0x3bf5a4385af0d4dfd2eb38713ae21d9fc82c0542` (a live DreamDEX ETH 5-minute
market) returns `oneCollateral = 1000000` (`0xf4240`).

### Approvals

| Verb | What must be approved | To whom |
|---|---|---|
| `mintSet` | ERC-20 `approve(pool, amount)` on the **collateral** token | the **pool** (it pulls) — `src/binary/sets.ts:9-10` |
| `burnSet` | ERC-6909 `setOperator(pool, true)` on the **outcome singleton** | the **pool** — `src/binary/sets.ts:23-27` |
| `redeem` (module) | ERC-6909 `setOperator(module, true)` | the **module** — `src/binary/settlement.ts:62-76` |
| `redeemDirect` | ERC-6909 `setOperator(settlement, true)` | the **settlement** — `src/binary/settlement.ts:194-199` |

One ERC-6909 `setOperator` covers *every* id on the singleton and therefore every
market and both sides, forever (`src/writer.ts:805-809`). For KeelVault that is
three one-time grants total (pool-per-pool, module, settlement) plus one
`approve(pool, type(uint256).max)` per pool. The SDK approves `maxUint256`
(`src/writer.ts:801`).

### Collateral token on Shannon

* **tUSDC = `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E`** —
  `src/addresses.ts:23` (`collateral`) and `:29` (`testUsdc`, same address).
* **decimals = 6**, verified by live `eth_call` `decimals()` → `0x…06`.
* **symbol = `tUSDC`**, verified by live `eth_call` `symbol()`.
* Faucet: `faucet(uint256 amount)` (selector `0x57915897`) on that token —
  `src/actionsAbi.ts:26`.
* SDK's default decimals constant is 6 (`src/store.ts:320`,
  `src/trade.ts:65` `decimals?: number // default 6`). **Do not hard-code it**
  anywhere else: `quoteDecimals` is per-venue (`src/markets.ts:76-80`).

### Full Shannon address book (`src/addresses.ts:17-31`, `SOMNIA_TESTNET_ADDRESSES`)

| Key | Address |
|---|---|
| `binaryModule` (BinaryMarketsModule) | `0x3ecC694Cef705358864a646142ac17A90E29e388` |
| `binarySettlement` | `0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23` |
| `marketsCore` | `0x2802504314685D89bF6C992CA5a8e7cC78bc0294` |
| `marketCreator` | `0x138CfA6b80475b8c03d7E468b2442278E51e645a` |
| `marketCreatorFactory` | `0xE6bEE93cE87c9E6e62aCb621caa7832EE47b4F6B` |
| `clobFactory` | `0x1a478019Ae4d24249a962934af0f129CE98B5e6f` |
| `oracleHub` | `0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b` |
| `collateralRouter` | `0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C` |
| `collateral` / `testUsdc` | `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` |
| `binaryPoolBeacon` | `0x85C01B5ef4F4ed59caC69749565e309f01b14Dbc` |
| `binaryPoolImpl` | `0x48e523c9f22f98548d263f0aD444D732e5202C0E` |
| **ERC-6909 outcome singleton** | `0xb52c5934113af5c0bb20eb3c72290c8215f755b9` — *not* in `addresses.ts`; read live from `pool.getBinaryPoolParams().outcomeToken` (see §5) |

`marketCreatorFactoryV2` is a supported config key (`src/config.ts:96-101`) but is
**not** present in the baked-in Shannon addresses — so the v1 factory is what you
get by default, and `triggerRoll` (v1-only) is available.

Live-verified module wiring: `binaryModule.settlement()` →
`0xbf4a49e0dfd092e5fbe8e5761064c49533e6ed23` (matches `addresses.ts:21`), and
`binaryModule.approvedAdapters(0xe40db387…)` → `true`.

### Minimal snippet (JS, for the reference bot)

```ts
import { createClient, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const client = createClient({
  indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
  chain: somniaShannon,
  wsRpcUrl: "wss://dream-rpc.somnia.network/ws",
  addresses: SOMNIA_TESTNET_ADDRESSES,
});
const trader = client.createTrader({ privateKey: process.env.PK as `0x${string}` });

// 100 tUSDC -> 100 Up + 100 Down. autoApprove handles the ERC-20 approve.
const { receipt } = await trader.mintSet({ pool, amount: 100_000_000n });
if (receipt.status !== "success") throw new Error("mintSet reverted");
```

### Minimal snippet (Solidity, for KeelVault)

```solidity
interface IBinaryPool {
    function mintSet(address yesTo, address noTo, uint256 amount) external;   // 0x54657dd2
    function burnSet(uint256 amount) external;                                // 0x55664dbd
    function getBinaryPoolParams() external view returns (
        address collateralToken, address market, address outcomeToken,
        uint256 yesId, uint256 noId, uint256 oneCollateral, uint256 setBacking,
        address feeRecipient, uint256 makerFeeBpsTimes1k, uint256 takerFeeBpsTimes1k,
        uint256 maxBuilderFeeBpsTimes1k, uint256 settlementFeeBpsTimes1k,
        address settlement, uint64 marketNonce, bool finalized);
}
interface IOutcome6909 { function setOperator(address spender, bool approved) external returns (bool); }

function _mintSets(address pool, uint256 amount) internal {
    (address collateral,, address outcome,,,,,,,,,,,,) = IBinaryPool(pool).getBinaryPoolParams();
    IERC20(collateral).approve(pool, type(uint256).max);   // once per (collateral, pool)
    IOutcome6909(outcome).setOperator(pool, true);         // once per (singleton, pool); needed to SELL/burn
    IBinaryPool(pool).mintSet(address(this), address(this), amount);
}
```

---

## 2. Order placement

### **`placeOrder` is the wrong function on a binary pool.**

`src/tradeAbi.ts:25-27` — *"the generic `placeOrder`/`placeOrderFor`/`amendOrder`
entries **REVERT `UseBinaryPlacement`** on a binary pool."* Confirmed by the
error being in the generated table (`src/contractErrorsAbi.ts:479`). The binary
entry point is `placeBinaryOrder`.

There is no `createOrder` or `placeLimit` on the low-level client. `createOrder`
exists only on the CCXT-style unified facade (`SomniaMarkets`,
`src/unified/exchange.ts`) which wraps the same call.

### Signature

```solidity
// src/tradeAbi.ts:32 — selector 0x718c2d4d
function placeBinaryOrder(
    uint8   kind,                    // OrderKind
    uint256 price,                   // ALWAYS the YES-side price, raw collateral units
    uint256 quantity,                // outcome-token units, raw
    uint64  expireTimestampNs,       // nanoseconds; 0 < v <= pool.marketExpiryNs()
    uint8   orderType,               // OrderType
    uint8   selfMatchingOption,      // SelfMatchingOption
    address builder,                 // 0x0 for none
    uint96  builderFeeBpsTimes1k,    // MUST be uint96 — selector-critical
    uint64  userData                 // opaque MM tag, forwarded verbatim
) payable returns (bool success, uint128 id);
```

Note the argument list the question asked about (`isBid, userData, price, …`) is
the **spot/perp** shape (`src/tradeAbi.ts:90`, `:159`), not binary. On binary,
`isBid` is replaced by the `kind` enum and `userData` moves to the **end**.

### `payable`?

**Yes, the selector includes `payable`** — `src/tradeAbi.ts:30-31`: *"`payable`
mirrors the on-chain signature (binary pools take no `msg.value`, but the
selector includes it)."* So declare it `payable` in your interface, and send
`msg.value == 0`. (Spot's `placeOrder` is genuinely payable for native-base
sells; perp's is non-payable — `src/tradeAbi.ts:144-145`.)

### Enums

| Enum | Values | Source |
|---|---|---|
| `kind` (OrderKind) | `0 BUY_YES`, `1 SELL_YES`, `2 BUY_NO`, `3 SELL_NO` | `src/writer.ts:81-86`, `src/tradeAbi.ts:28` |
| `orderType` (OrderType) | `0 NormalOrder` (limit, rests), `1 FillOrKill`, `2 ImmediateOrCancel` (= "market"), `3 PostOnly` | `src/trade.ts:389-398` (`ORDER_TYPE`) |
| `selfMatchingOption` | `0 CANCEL_TAKER` (default), `1 CANCEL_MAKER` | `src/trade.ts:722-734` (`SELF_MATCHING_OPTION`) |

The SDK defaults `orderType = 0` and `selfMatchingOption = 0`
(`src/orders.ts:1040`, `:1064`). `src/trade.ts:715-718` is explicit that the `0`
default is *the SDK's* choice — **the pool has no default**, so KeelVault must
pass both explicitly.

For Keel's resting two-sided quotes: `orderType = 3` (PostOnly) is the correct
choice — it guarantees the order never takes, and reverts `PostOnlyWouldCross`
(`src/contractErrorsAbi.ts:382`) instead of eating the book.

### Price scale — probabilities

`src/units.ts:95-98`:

> A binary YES limit price is **raw collateral per whole outcome token**: full
> collateral (`10^decimals`) buys a share worth 1, so `price / 10^decimals` is
> the YES probability in `[0, 1]`. NO probability is the complement.

So on Shannon (tUSDC, 6dp): **`price = round(p_up * 1e6)`**, range `(0, 1e6)`.
Helpers: `probabilityToPrice(p, decimals)` / `priceToProbability(raw, decimals)`
(`src/units.ts:105-121`).

Critically — **the price is always YES-terms, even for NO orders**
(`src/tradeAbi.ts:28-29`, `src/tradeAbi.ts:19-20`). To rest a Down ask at Down-probability
`q`, send `kind = SELL_NO (3)` with `price = round((1 - q) * 1e6)`.

The SDK enforces `price > 0 && quantity > 0` client-side
(`src/orders.ts:1036-1038`).

### Tick grid and quantity scaling

Read them, don't assume: `getOrderBookParameters()` → `(tickSize, minQuantity,
lotSize)` (`src/readsAbi.ts:36`), all raw:

* `tickSize` — minimum price increment, **raw quote/collateral units**
* `minQuantity` — minimum order quantity, raw outcome-share units
* `lotSize` — quantity increment, raw outcome-share units

(`src/marketCreatorAdmin.ts:33-40`.)

**Live-verified on Shannon DreamDEX** (pool `0x3bf5a438…`, and identically on the
DreamDEX MarketCreator's `defaultBookParams()`):

```
tickSize = 1000, minQuantity = 1000, lotSize = 1000
```

At 6 decimals that means: prices snap to **0.001 = 0.1 % probability**, and
quantities snap to **0.001 shares** with a 0.001-share floor. An off-grid price
reverts `InvalidPrice(price, tickSize)` (`src/contractErrorsAbi.ts:226`); an
off-lot/under-minimum quantity reverts `InvalidQuantity(quantity, constraint)`
(`:227`).

`src/units.ts:64-79` documents a real trap: converting a JS float price through
`toFixed` can land three wei off a tick and get the order rejected with
`InvalidPrice`. In Solidity, snap explicitly: `price = (price / tickSize) * tickSize`.

### `expireTimestampNs` — mandatory

**Yes.** `src/trade.ts:184-196` and `src/orders.ts:1041-1047`:

> every order must satisfy `0 < expireNs <= pool.marketExpiryNs` (the pool rejects
> `OrderExpiryBeyondMarket` otherwise, so the book stays drainable via the expiry
> sweeps after the market locks).

* There is **no GTC** on binary. Left unspecified, the SDK reads
  `pool.marketExpiryNs()` and uses that (`src/writer.ts:750-756`).
* A past value reverts `OrderAlreadyExpired` (`src/contractErrorsAbi.ts:351`) —
  the SDK does not clamp.
* `marketExpiryNs` is **expiry seconds × 1e9**. Live-verified: pool
  `0x3bf5a438…` returns `0x18d134b9e1854800 = 1788268500000000000` ns, and the
  indexer's `expiry` for that market is `1788268500`.

### What happens at expiry

Expiry is **lazy**: `src/orders.ts:423-425` — *"On-chain expiry is LAZY (an
expired maker keeps resting with no `OrderExpired` event)"*. The order stops
being matchable but its escrow stays locked until someone calls
`cancelOrder`, `cancelExpiredOrders`, or `sweepExpiredAtLevel` — the latter two
are **permissionless keeper drains** that return each order's escrow to its owner
and skip non-expired ids rather than reverting (`src/tradeAbi.ts:42-49`).
`reduceOrder` on an expired order reverts `ExpiredOrderMustBeCancelled`
(`src/tradeAbi.ts:40`).

**Keel consequence:** every quote dies at the window's own expiry, so the
re-quote loop must be driven by the roll, not by an order TTL.

### Escrow (what the pool pulls)

`src/writer.ts:766-777` — this is the exact rounding the pool applies:

| kind | escrow |
|---|---|
| `BUY_YES` | ERC-20 collateral, `ceil(quantity * price / 1e6)` |
| `BUY_NO` | ERC-20 collateral, `ceil(quantity * (1e6 - price) / 1e6)` |
| `SELL_YES` | ERC-6909 id `yesId`, `quantity` |
| `SELL_NO` | ERC-6909 id `noId`, `quantity` |

So Keel's "mint a set, rest both as asks" is exactly the two `SELL_*` rows: the
minted set *is* the escrow, no further collateral is locked.

### Return values

`placeBinaryOrder` returns `(bool success, uint128 id)` — readable from Solidity.
From JS you cannot read tx return data, so the SDK decodes the receipt:
`OrderPlaced(uint128 indexed orderId, (uint128,bool,address,uint64,uint256,uint256,uint256,uint64) placedOrder)`
and `OrderFilled(...)` (`src/eventsAbi.ts:22-84`, decoded at
`src/writer.ts:653-684`). A binary pool *additionally* emits
`BinaryOrderPlaced(uint128 indexed orderId, uint8 kind)` — the **only**
authoritative side source in v2 (`src/eventsAbi.ts:310-327`).

### Snippet (Solidity)

```solidity
interface IBinaryPool {
    function placeBinaryOrder(
        uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs,
        uint8 orderType, uint8 selfMatchingOption,
        address builder, uint96 builderFeeBpsTimes1k, uint64 userData
    ) external payable returns (bool success, uint128 id);
    function getOrderBookParameters() external view
        returns (uint256 tickSize, uint256 minQuantity, uint256 lotSize);
    function marketExpiryNs() external view returns (uint64);
}

uint8 constant KIND_SELL_YES = 1;
uint8 constant KIND_SELL_NO  = 3;
uint8 constant TYPE_POST_ONLY = 3;
uint8 constant SMO_CANCEL_TAKER = 0;

/// @param yesPx raw YES price (6dp). Both legs quote in YES terms.
function _quoteBothSides(address pool, uint256 yesAskPx, uint256 noAskPxInYesTerms, uint256 qty)
    internal returns (uint128 upId, uint128 downId)
{
    (uint256 tick,, uint256 lot) = IBinaryPool(pool).getOrderBookParameters();
    uint64 exp = IBinaryPool(pool).marketExpiryNs();
    qty = (qty / lot) * lot;
    (, upId)   = IBinaryPool(pool).placeBinaryOrder(
        KIND_SELL_YES, (yesAskPx / tick) * tick, qty, exp,
        TYPE_POST_ONLY, SMO_CANCEL_TAKER, address(0), 0, 0);
    (, downId) = IBinaryPool(pool).placeBinaryOrder(
        KIND_SELL_NO,  (noAskPxInYesTerms / tick) * tick, qty, exp,
        TYPE_POST_ONLY, SMO_CANCEL_TAKER, address(0), 0, 0);
}
```

---

## 3. Cancellation and order ownership

* `cancelOrder(uint128 orderId)` — selector `0xdbc91396`, on the pool
  (`src/tradeAbi.ts:34`). Batch: `cancelOrders(uint128[]) returns (bool[])`,
  selector `0x0dce6933` (`src/tradeAbi.ts:138`) — inherited from the OrderBook
  base and explicitly **not** placement-gated, so it works on binary pools
  (`src/tradeAbi.ts:110-111`).
* `reduceOrder(uint128, uint256 newQuantityRemaining)` shrinks in place and
  **keeps price-time priority** — unlike cancel+replace, which re-queues at the
  back (`src/tradeAbi.ts:35-41`). BinaryPool implements the refund hook, so freed
  escrow returns to the owner.

### Ownership is `msg.sender`

Yes — a contract owns the orders it places. Evidence:

1. The order struct carries an explicit `owner` field
   (`OrderPlaced.placedOrder.owner`, `src/eventsAbi.ts:33`;
   `getOrder(...)` returns the same, `src/readsAbi.ts:18`).
2. There is a separate `placeBinaryOrderFor(address owner, …)`
   (`src/tradeAbi.ts:33`) — a distinct entry point *exists precisely because* the
   plain one pins the owner to the caller.
3. The `*For` family (`placeOrderFor` / `cancelOrderFor` / `reduceOrderFor`) is
   gated by a separate `OperatorPermissionsRegistry`
   (`src/readsAbi.ts:162-171`, `src/tradeAbi.ts:311-320`,
   `src/spot/operatorGrants.ts:28-44`) — i.e. acting on *someone else's* orders
   requires an explicit grant.
4. `getOwnOpenOrders()` "answers for `msg.sender`"
   (`src/readsAbi.ts:12-14`), and the SDK impersonates via `eth_call`'s `from`
   to read it.
5. `InvalidOrderOwner()` is in the generated error table
   (`src/contractErrorsAbi.ts:211`).

The exact revert selector `cancelOrder` uses for a non-owner caller is
**UNVERIFIED** (I did not have the OrderBook Solidity source; `InvalidOrderOwner`
is the plausible candidate). The ownership semantics themselves are firmly
established by (1)–(4).

**Keel consequence:** `KeelVault` places, holds, and cancels its own orders with
no registry wiring at all. Track ids from `placeBinaryOrder`'s `uint128 id`
return value.

---

## 4. Launch path (venue → creator → series → roll)

### Sequence

```
1. MarketsCore.registerOperator(feeRecipient, enabled, policy, context)      -> uint32 operatorId
2. BinaryMarketsModule.encodeVenueFeeParams({maker,taker,maxBuilder,routing,settlement,voidPolicy})
                                                                             -> bytes feeParams
3. MarketsCore.createVenue(operatorId, 0x06c65d9f, VenueConfig{feeParams, feeRecipientOverride,
                                                    policy, signer, creationEnabled, context})
                                                                             -> bytes32 venueId
4. MarketCreatorFactory.createMarketCreator(owner, core=binaryModule, adapter=oracleHub,
                             operatorId, venueId, {tickSize, minQuantity, lotSize})
                                                                             -> (creator, policy)
5. (venue policy must allow `creator`)  MarketCreatorPolicy.setCreator(creator, true)
6. send native STT to creator.receive()          // pays reactivity gas + per-create oracle value
7. MarketCreator.registerSeries(seriesId, {collateral, asset, numericDecimals,
                                           intervalSec, settlementWindow})
8. MarketCreator.triggerRoll(seriesId)           // v1 — mints the first market and arms the loop
   (or armFirstRoll(seriesId, firesAtSec) to start at a future aligned boundary)
```

SDK entry points: `client.createOperatorAdmin(cfg)` → `registerOperator` /
`createVenue` (`src/operatorAdmin.ts:254, 270, 346, 379`);
`client.createMarketCreatorAdmin(cfg)` → `createMarketCreator` /
`fundMarketCreator` / `registerSeries` / `triggerRoll` / `armFirstRoll`
(`src/marketCreatorAdmin.ts:320-400`, impl `:428-545`).

### `marketType` for step 3

`MARKET_TYPE_BINARY_V1 = 0x06c65d9f` (`= bytes4(keccak256("BINARY_V1"))`) —
`src/operatorReads.ts:15-21`. Live-verified: the DreamDEX venue's indexed
`marketType` is exactly `0x06c65d9f`.

### `registerSeries` argument

```solidity
// src/machineryAbi.ts:143 — selector 0x9360d325
struct Series { address collateral; string asset; uint64 numericDecimals;
                uint64 intervalSec; uint64 settlementWindow; }
function registerSeries(uint32 seriesId, Series s) external;   // owner-only, upserts by seriesId
```

Params doc at `src/marketCreatorAdmin.ts:115-139`:

* `seriesId` — per-creator key; **re-registering overwrites the config and resets
  the series' oracle reference** (`:118-122`).
* `collateral` — per-series ERC-20.
* `asset` — see below.
* `numericDecimals` — decimal precision of the oracle's numeric price answer.
* `intervalSec` — roll cadence.
* `settlementWindow` — post-expiry seconds the oracle still has; `expiry +
  settlementWindow` is when the permissionless `voidExpired()` unlocks
  (`src/readsAbi.ts:113-115`, `src/actionsAbi.ts:11-18`).

### Minimum interval — **60 s confirmed**

* `export const MIN_SERIES_INTERVAL_SEC = 60;` — `src/preflight.ts:74`, with the
  doc comment *"The minimum roll interval the module enforces
  (`InvalidSeriesConfig` below)"* (`:69-72`).
* `src/marketCreatorAdmin.ts:133`: *"Roll interval in seconds; the module rejects
  `< 60` (`InvalidSeriesConfig`)."*
* `src/marketCreatorAdmin.ts:334-335`: *"`intervalSec` must be >= 60 and `asset`
  non-empty (the module reverts otherwise)."*
* `InvalidSeriesConfig()` is in the generated error table
  (`src/contractErrorsAbi.ts:230`).

The SDK does **not** pre-check it — `registerSeries` forwards the value verbatim
(`src/marketCreatorAdmin.ts:476-494`); the revert comes from the module.

Live cross-check: existing series on Shannon run at `intervalSec` 300 and 900;
the DreamDEX creator's `seriesById(1)` decodes to
`collateral=tUSDC, asset="BTC", numericDecimals=2, intervalSec=900, settlementWindow=300`.

### Asset string

`src/marketCreatorAdmin.ts:125-130`:

> Display ticker (e.g. `"BTC"` — **NOT a pair**). Doubles as the exchange base
> symbol for the USDC-quoted candle sources built per roll, so **it must match
> the spot listing on the source exchanges (Binance/OKX/…)**.

There is **no on-chain allow-list of valid tickers** anywhere in the SDK — the
only contract-level constraint is non-empty. The real constraint is that the
oracle's candle sources must resolve the symbol on the named exchanges; an
unlisted ticker produces a series that registers fine and then never resolves.
The precise source-exchange list and their symbol rules are **UNVERIFIED** (the
`QuestionDefinition.sources` payload is built by the MarketCreator on-chain per
roll — `src/machineryAbi.ts:16-25` documents the tuple shape but not the source
catalogue).

Live-observed assets in use on Shannon: `Series.asset` ∈ `{BTC, SOMI}`;
`Market.asset` ∈ `{BTC, ETH, DECEDO}` (indexer `distinct_on` queries).

### Oracle adapter selection — **one approved adapter, nothing to arm**

Confirmed:

* `src/machineryAbi.ts:239-243`: *"Adapter approval is module-OWNER-gated. In
  Oracle v2 the ONE approved adapter is the OracleHub."*
* `src/marketCreatorAdmin.ts:58-63`: `adapter` *"Defaults to the protocol's
  OracleHub (`config.addresses.oracleHub`) — Oracle v2's ONE approved adapter;
  **there is nothing to mint or arm per operator**."*
* `src/binary/plugin.ts:5-7` and `src/preflight.ts:12-16` both restate that the
  per-operator adapter step is **gone**.
* Live: `binaryModule.approvedAdapters(0xe40db387…oracleHub)` → `true`.

**But** the step it was replaced by is not free. `src/binary/plugin.ts:30-35` and
`src/oracleHub.ts:296-306`: each create must attach native value
`quoteCreateMarketValue(def) = getSchedulingCost(def) + resolveReserve()`;
the reserve is *earmarked per market at bind* and surplus is credited back.
Live: `oracleHub.resolveReserve()` = `0x2c68af0bb140000` = **0.2 STT per market
creation**, plus scheduling cost (0 for a question that already exists — the hub
is content-addressed and dedups, `src/machineryAbi.ts:34-36`). The MarketCreator
pays this out of its own native float, which is why step 6 exists.
`reclaimOracleCredit()` (`src/machineryAbi.ts:152`) sweeps accrued surplus back.

### `triggerRoll` — the design-doc claim is only half right

`src/marketCreatorAdmin.ts:343-350`:

> **V1 ONLY**: roll a series to its next market (owner-only). MarketCreatorV2
> dropped `triggerRoll` […] Calling this against a v2 creator reverts (selector
> absent). **NOTE: calls the Somnia reactivity precompile — only succeeds on
> testnet/mainnet, not local anvil.**

And `src/machineryAbi.ts:140-141`: *"`triggerRoll` / reactivity params touch the
Somnia precompile (testnet/mainnet only). Fund with native (`receive`)."*

So it is owner-called, but it is **not** "a plain function that rolls the series
manually" — it mints the market *and* arms a reactivity subscription that drives
subsequent rolls automatically, it costs native (reactivity gas + the oracle
create value), and it is absent from MarketCreatorV2. Set the creator's
reactivity gas params first: `setReactivityGasParams(uint64 priorityFeePerGas,
uint64 maxFeePerGas, uint64 gasLimit)` (`src/machineryAbi.ts:159`).

### The venue policy gate — a Keel blocker worth knowing

`createVenue`'s `policy` field: *"IVenuePolicy address; zero means no per-venue
gate […] **Creation needs SOME create-side policy set** — point this at the
deployed OpenPolicy to make the venue open."* (`src/operatorAdmin.ts:60-64`.)
`signer`: *"non-zero requires a venue-signed authorization to create"*
(`:65-66`) — and `src/marketCreatorAdmin.ts:66-70` warns the venue must be one
whose create path does **not** require a signature, because the roll loop cannot
produce per-create signatures.

Live-verified for the **DreamDEX venue**
`0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c`:

```
operatorId       = 2
marketType       = 0x06c65d9f            (BINARY_V1)
policy           = 0xa24822b8d4adcc770c8b071e0dc8e19c39991204   (non-zero: allowlist gate)
signer           = 0x0000…0000           (no venue signature required)
creationEnabled  = true
feeParams        = version 2, all rates 0
```

and `policy.approved(0x94d963b6670ab96e78c8d0c46ca35d196d606efe)` → `true` (that
address is the `creator` on DreamDEX's two most recent markets), while
`policy.approved(<another creator>)` → `false`.

**Consequence for KeelFactory:** you cannot launch a series onto DreamDEX's own
venue — its `MarketCreatorPolicy` allowlist is owned by DreamDEX. KeelFactory must
run steps 1–5 to stand up **its own operator + venue + creator + policy**, with
`signer = 0x0` and `creationEnabled = true`, and call `setCreator` on the policy
the factory itself minted.

The address that owns `MarketCreatorPolicy` / the exact `OpenPolicy` deployment
address on Shannon is **UNVERIFIED** — `createMarketCreator` mints a policy for
you (`src/machineryAbi.ts:127` returns `(creator, policy)`), which is the
supported path; a venue-level `policy` value for step 3 is still yours to supply.

---

## 5. Positions — ERC-6909

### One singleton, ids derived from `(pool, nonce, outcomeIdx)`

`src/readsAbi.ts:137-141`:

> The protocol-level ERC-6909 outcome-token singleton. **ONE contract** holds
> every market's YES/NO positions as ids […] Approval is per-operator
> (`setOperator`) — one approval covers every market — not per-token allowance.

Encoding (`src/ids.ts:1-49`, mirroring `IBinaryPool.outcomeId`):

```
id        = (uint160(pool) << 72) | (uint64(nonce) << 8) | idx     // idx: 0 = YES/Up, 1 = NO/Down
marketKey = id >> 8 = (uint160(pool) << 64) | nonce                // keys the BinarySettlement record
```

`nonce` is the pool's **`marketNonce`** — 1 on a fresh pool, `++` on each
recycle. It exists because a pool is reused across successive markets, so
`(pool << 8) | idx` would collide (`src/ids.ts:3-15`). Read it from
`pool.marketNonce()` (selector `0xcaa855b3`, `src/readsAbi.ts:74`) or
`binaryModule.marketNonce(bytes32 marketId)` (`0x9e48ee0b`,
`src/moduleAbi.ts:92`). Helpers: `outcomeId()` `src/ids.ts:46`,
`decodeOutcomeId()` `:70`, `marketKey()` `:88`.

### Singleton address on Shannon

**`0xb52c5934113af5c0bb20eb3c72290c8215f755b9`** — live-verified from
`getBinaryPoolParams()` on pool `0x3bf5a4385af0d4dfd2eb38713ae21d9fc82c0542`
(field 3, `outcomeToken`). Same call returned
`yesId = 0x…3bf5a4385af0d4dfd2eb38713ae21d9fc82c0542_0000000000000060_00` and
`noId = …_01` with `marketNonce = 0x60 = 96`, which reproduces the `src/ids.ts`
formula exactly (I recomputed `(pool << 72) | (96 << 8) | 0` and got a byte-for-byte
match).

The singleton is **not** in `SOMNIA_TESTNET_ADDRESSES`. Read it per pool from
`getBinaryPoolParams()` or `pool.outcomeToken()` (`0xa998d6d8`) rather than
hard-coding it.

### ERC-6909 surface (`src/readsAbi.ts:148-156`)

```solidity
function balanceOf(address owner, uint256 id) view returns (uint256);     // 0x00fdd58e
function allowance(address owner, address spender, uint256 id) view returns (uint256);
function isOperator(address owner, address spender) view returns (bool);  // 0xb6363cf2
function approve(address spender, uint256 id, uint256 amount) returns (bool);
function setOperator(address spender, bool approved) returns (bool);      // 0x558a7297
function transfer(address receiver, uint256 id, uint256 amount) returns (bool);
function transferFrom(address sender, address receiver, uint256 id, uint256 amount) returns (bool);
```

### Redemption after settlement

Three routes, all verified:

1. **Module-routed (canonical, trader-facing)** —
   `BinaryMarketsModule.redeem(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount)`, selector `0x5b1ffcf2`
   (`src/moduleAbi.ts:20`, SDK `src/binary/settlement.ts:37-84`). The module pulls
   the winning outcome tokens from `msg.sender` (needs `setOperator(module, true)`),
   finalizes if needed, and redeems through settlement.
   `operatorId`/`venueId` are attribution only and may be `0`
   (`src/moduleAbi.ts:18-19`).
   Batch form `redeemMany` (`0x88cb9474`) is all-or-nothing across entries.
2. **Direct settlement** — `BinarySettlement.redeem(uint256 outcomeId, uint256 amount, address to) returns (uint256 collateralOut)`, selector `0x049104e5`
   (`src/readsAbi.ts:90`). Needs `setOperator(settlement, true)`.
3. **Pull fallback** — if the payout push reverted (e.g. a contract with no
   payable receiver), `BinarySettlement.claimOwed(address token) returns (uint256)`,
   selector `0x798a6ca5` (`src/readsAbi.ts:93`), balance readable via
   `owed(address user, address token)` (`:96`).

Keeper prerequisites: `finalizeMarket(bytes32)` sweeps the pool's backing into
settlement, `releasePool(bytes32)` frees a drained pool back to its creator's
free list for recycle — both **permissionless**
(`src/moduleAbi.ts:26-31`). Free-pool reads: `getFreePools(creator, collateral)`
/ `freePoolCount(...)` (`src/moduleAbi.ts:88-89`).

### Determining the winner

**`winningOutcome()` was removed and reverts on the deployed market contract.**
`src/tradeAbi.ts:373-376` and `src/binary/settlement.ts:46-47`: settlement v3
stores a **payout vector**. Derive the winner as `argmax(payoutNumerators())`,
gated on `isResolved()`; disambiguate a void (uniform vector) with `isVoided()`
(`src/markets.ts:1911-1918`). `PAYOUT_VECTOR_DENOMINATOR = 10_000_000`
(`src/binary/settlement.ts:353-357`).

> This supersedes the project's `CLAUDE.md` note about
> `Market.winningOutcome == 0`: that field still exists on the **indexer**
> (`src/markets.ts:296-303`, derived by the indexer from a one-hot vector) but
> the **on-chain getter is gone**. KeelVault must read `payoutNumerators()`.

Estimated payout (`src/derivedReads.ts:601-608`): winner gets
`amount * (10_000 - settlementFeeBps) / 10_000`; a voided market pays
`amount / 2` on **both** sides; loser gets 0.

---

## 6. Reads and their decimal scales

| Method | Signature | Source | Scale of returned prices |
|---|---|---|---|
| `listBinaryMarkets` | `(opts?: BinaryMarketFilter & {limit?}) => Promise<BinaryMarket[]>` | `src/markets.ts:987-1000` | `lastPrice` raw ≈ `p_up × 10^quoteDecimals` (`src/markets.ts:64`); `strike` raw **in the oracle's price scale** (`src/markets.ts:282`); `backing` raw collateral. Format with the row's own `quoteDecimals` (`src/markets.ts:76-80`). |
| `getMarketOnchain` | `(marketId: Hex) => Promise<MarketOnchain>` | `src/markets.ts:1856-1955` | `backing` raw collateral at `decimals` (the field it returns, read from the collateral ERC-20). Takes the **bytes32 marketId**, not an address — a 20-byte value is rejected loudly (`:1861-1866`, breaking change in 0.13.0). |
| `getBookTops` | `(marketIds: string[]) => Promise<Record<string, BookTop>>` | `src/orders.ts:427-461`; type `:407-414` | `bestBid`/`bestAsk`/`mid` **raw YES price strings** = `p × 10^quoteDecimals`. `mid` is integer-floored and is `null` unless both sides rest. Markets with an empty book are **absent from the map**. Filters out expired orders client-side (lazy on-chain expiry, `:423-425`). |
| `getOpeningPrices` | `(marketIds: string[]) => Promise<Record<string, string \| null>>` | `src/markets.ts:1388-1420` | **Raw oracle `numericValue`, scale NOT carried.** See below. |
| `getResolutionPrices` | same shape | `src/markets.ts:1451-1476` | same, scale not carried; a voided answer returns `null`. |
| `fetchPrice` | `(asset: string) => Promise<LivePrice \| null>` | `src/createClient.ts:457`, `src/priceFeed/query.ts:235-243` | **1e18.** `PRICE_FEED_DECIMALS = 18` (`src/priceFeed/types.ts:26`); `raw.spot`/`raw.ema` are exact 1e18-scaled integer strings; the `price`/`ema` number fields are `raw / 1e18` and lossy (`src/priceFeed/types.ts:56-78`). |
| `getClaimable` | `(account: string) => Promise<ClaimablePosition[]>` | `src/createClient.ts:402`, types `src/derivedReads.ts:553-570` | `amount` and `estPayout` are raw collateral/outcome units. Rows are shaped to feed straight into `trader.redeemMany({entries})`. |

### The 1e2-vs-1e18 question — **the prior report is correct, with a caveat**

`src/moduleAbi.ts:55-59` is explicit:

> `PRICE_DECIMALS` is NOT part of `IOracleAdapter` — the answer scale is a
> per-question `numericDecimals` […] the price-feed adapter answers in **18**
> decimals and exposes this getter, while **OracleHub answers in 2** and has no
> getter at all.

And `src/markets.ts` (the `getResolutionPrices` doc block, `:1426-1450`):

> **SCALE IS NOT CARRIED, and that is a trap worth stating.** Callers scale these
> by the explorer's `ORACLE_PRICE_DECIMALS` (2), which is **empirical, not
> schema-backed**: `OracleAnswer` has no decimals column […] So the day the
> indexer starts ingesting an 18-decimal adapter's answers, this function begins
> returning 18-decimal values that every caller divides by 100.

Live confirmation for Keel's actual markets: the DreamDEX MarketCreator's
`seriesById(1)` returns `numericDecimals = 2`. So **today, on Shannon DreamDEX
markets, opening/resolution prices are 1e2-scaled while `fetchPrice` spot is
1e18-scaled — a 1e16 ratio.**

**Verdict: confirmed, but do not hard-code the 2.** The robust read is
`getMarketOnchain(...)` → `markets(marketId)[6]` (the adapter) →
`adapter.PRICE_DECIMALS()` with a documented fallback of 2
(`getOnchainResolutionPrice`, `src/markets.ts:1778-1828` — note it treats a
*revert* as absence but re-throws a transport failure, precisely so a failed
scale read cannot silently fall back to 2).

Also worth carrying: for a `"reference"`-mode (up/down) market `strike` is `"0"`
by construction and the real boundary is the reference question's answer
(`src/markets.ts:280-291`, helper `boundaryPrice()` at `src/markets.ts:1365-1378`).
That matches the project's existing observation that `Market.strike` is always
`"0"` — it is not a bug, it is the mode.

---

## 7. Failure modes — does a revert throw?

**In 0.29.0 a reverted write throws `ContractRevertError`. It does not resolve.**

`src/writer.ts:610-648`, the single send funnel:

```ts
if (localAccount) {
  const serialized = await signCall(...);
  const receipt    = await broadcast(serialized, w);
  if (receipt.status === "reverted") throw await revertErrorForReceipt(receipt, w);   // :618
  return { hash: receipt.transactionHash, receipt };
}
const hash = await wallet().writeContract({...});   // external signer
const result = await confirm(hash);
if (result.receipt.status === "reverted") throw await revertErrorForReceipt(result.receipt, w);  // :644
```

Both signer paths check. `revertErrorForReceipt` (`src/writer.ts:584-604`)
replays the same calldata as an `eth_call` **at the receipt's block** to recover
the Solidity error name (a mined-and-reverted receipt carries no revert data), and
falls back to a `ContractRevertError` with `reason: "transaction 0x… reverted (no
revert data recoverable)"` if the replay cannot run. Error names are decoded from
a generated table (`src/contractErrorsAbi.ts`, 521 lines) exported as
`contractErrorsAbi` / `decodeRevert` (`src/index.ts:252`, `src/revert.ts`).

### Simulation

* **Local-signer path (`privateKey` / local account): NO simulation.** The SDK
  signs and broadcasts directly (`src/writer.ts:613-616`), preferring
  `realtime_sendRawTransaction` (send + confirm in one server-side round-trip)
  with a plain `eth_sendRawTransaction` + `newHeads` fallback
  (`src/writer.ts:12-15`, `src/txSend.ts:1-11`). No `eth_call` precedes the send.
* **External-signer path: viem's `writeContract` simulates first**, so a revert
  surfaces at send time with data attached; the SDK decodes it rather than
  leaking viem's error (`src/writer.ts:635-640`).
* Gas is a fixed ceiling, not estimated: `gas ?? defaultGas`, default
  `10_000_000n` (`src/trade.ts:68-71`).

### Was 0.28.x really broken?

**Refuted for 0.28.1.** The downloaded 0.28.1 tarball has the identical checks at
`v28/package/src/writer.ts:586` and `:612`. So whatever version the prior report
described, it was **not** 0.28.1 — the silent-success bug was already fixed there.

### How a caller must check

* **From JS:** the SDK throws, so `try/catch` around the call is sufficient. But
  the belt-and-braces check is cheap and correct in every version — and it is
  what I'd write, since `TxResult.receipt` is exposed precisely for this
  (`src/trade.ts:76-85`):

  ```ts
  const res = await trader.placeOrder({ ... });
  if (res.receipt.status !== "success") throw new Error(`reverted ${res.hash}`);
  ```
  Note `TransactionReceipt.status` is viem's **string** union
  `"success" | "reverted"`, not a number — comparing to `1` silently always fails.

* **Additional order-level check:** `placeBinaryOrder` returns
  `(bool success, uint128 id)` and a *successful transaction* can still contain a
  *rejected order* — e.g. a `PostOnly` that would cross. From JS,
  `PlaceOrderResult.orderId` is `undefined` when no `OrderPlaced` was emitted
  (`src/trade.ts:148-153`, decoder `src/writer.ts:653-684`). Treat
  `orderId === undefined && fills.length === 0` as "the order did not land".

* **From Solidity:** check the returned `bool success`, and remember that
  best-effort verbs (`cancelExpiredOrders`, `sweepExpiredAtLevel`,
  `cancelOrders`) **do not revert** on skipped entries — `cancelOrders` returns
  `bool[] cancelled` (`src/tradeAbi.ts:138`).

* **One genuine all-or-nothing exception:** `amendOrders` cancels every old order
  first, then places every replacement, and the first rejected replacement
  reverts the whole tx with `AmendReplacementRejected(requestIndex, reason)`
  (`src/tradeAbi.ts:122-133`). Do not assume the best-effort shape transfers.

---

## 8. Fees

### Venue-level configuration (set by the venue owner at `createVenue`/`updateVenue`)

`BinaryVenueParams`, plain basis points, each capped at the module's
`MAX_FEE_BPS` (`src/operatorReads.ts:59-89`):

| Field | Meaning |
|---|---|
| `makerFeeBps` | pool protocol fee on maker-side fills |
| `takerFeeBps` | pool protocol fee on taker-side fills |
| `maxBuilderFeeBps` | per-order builder/routing fee **ceiling** the pool enforces at placement |
| `routingFeeBps` | advertised default routing fee; must be `<= maxBuilderFeeBps` |
| `settlementFeeBps` | skimmed from the **winning** payout at redemption; **never** charged on a voided (capital-refund) redemption |
| `voidPolicy` (v3) | `UNIFORM` (0) or `CLOB_SNAPSHOT` (2) |

These **freeze into each market at creation** — a later `updateVenue` only
affects markets created afterwards (`src/operatorReads.ts:67-72`).

Encode via the deployed module rather than re-deriving:
`encodeVenueFeeParams((uint64,uint64,uint64,uint64,uint64,uint8)) pure returns (bytes)`
(`src/operatorReads.ts:93-119`).

**Live-verified constants:**

* `binaryModule.MAX_FEE_BPS()` → `0x3e8` = **1000 bps = 10 %**.
* `binaryModule.FEE_PARAMS_VERSION()` → **3**. The decoder accepts legacy v2
  payloads (192 bytes, policy implied `UNIFORM`) as well as v3 (224 bytes) —
  `src/operatorReads.ts:23-30`. The live DreamDEX venue's `feeParams` is a **v2**
  payload, so the dual decoder matters in practice.

### Realized-fee accounting

Three separate indexed streams (`src/fees.ts:27-106`): `ProtocolFeeRecord`
(per-fill; `isTakerSide` distinguishes the rate — `false` is the *"maker rate
(burn-a-pair leg)"*, `src/fees.ts:43`), `BuilderFeeRecord`, `SettlementFeeRecord`
(skimmed **once at finalize**, not per-redeem, so it no longer moves the pool's
live `setBacking` — `src/eventsAbi.ts:300-306`).

### Builder-fee mechanism

Two-sided opt-in, both on the pool:

1. The **trader** approves a builder: `approveBuilder(address builder, uint256
   maxFeeBpsTimes1k)` (`0x605e0222`, `src/tradeAbi.ts:58`); `0` revokes.
2. Each order then carries `builder` + `builderFeeBpsTimes1k` (a **uint96** —
   *selector-critical*, `src/tradeAbi.ts:29`).
3. The pool clamps: the enforced ceiling is
   `min(user approval, pool's protocol-wide ceiling)`, readable as
   `getEffectiveBuilderApproval(user, builder)` (`0xf3e34804`) alongside
   `getBuilderApproval(user, builder)` (`0xc2531e86`) and
   `getMaxBuilderFeeBpsTimes1k()` (`0x78135d52`) —
   `src/tradeAbi.ts:56-63`, `src/fees.ts:301-351`.

Unit is **bps × 1000** on the pool surface, versus **plain bps** in the venue
config — do not mix them (`src/trade.ts:217-221` vs `src/operatorReads.ts:62`).

### Is `maxBuilderFeeBpsTimes1k` zero on testnet? — **Yes, on DreamDEX.**

Live `getBinaryPoolParams()` on DreamDEX pool `0x3bf5a4385af0d4dfd2eb38713ae21d9fc82c0542`:

```
makerFeeBpsTimes1k       = 0
takerFeeBpsTimes1k       = 0
maxBuilderFeeBpsTimes1k  = 0      <-- builder fees cannot be charged here
settlementFeeBpsTimes1k  = 0
feeRecipient             = 0xf685c1245b59800a9940131dc1952f39736ddc2a
```

Corroborated by the indexed venue row: `feeParams` decodes to version 2 with
**every rate zero**.

**Consequences for Keel:**

* Market-making on the existing DreamDEX venue is **fee-free** in both
  directions — every basis point of spread is retained. That is a real edge for
  the vault's economics, and it means the fair-value markup is the entire margin.
* A builder-fee demo on the DreamDEX venue is **impossible** — any non-zero
  `builderFeeBpsTimes1k` is above the ceiling and will be rejected.
* If Keel wants to *demonstrate* fee capture, it must do so on **its own venue**
  (§4), where it sets `makerFeeBps` / `takerFeeBps` / `maxBuilderFeeBps` itself,
  subject to `MAX_FEE_BPS = 1000`. This is a genuine argument in favour of
  KeelFactory launching its own venue rather than piggybacking.

---

## 9. Breaking changes, 0.28.1 → 0.29.0

Method: registry tarball diff (see header). **No CHANGELOG ships with the package.**

### Nothing was removed or renamed

* `src/index.ts` export symbols: **0 removed**, 68 added (set-difference over
  every `export { … }` clause).
* `SomniaMarketsClient` interface: **0 methods removed**, ~35 added (mostly perp
  linked-wallets, activity/tape reads, `getOrder`, `getSeries`,
  `getClosingPrice`, `getOnchainResolutionPrice`, `getResolutionPrices`,
  `countBinaryMarketsBounded`).
* `Trader` interface: **0 removed**, 1 added (`captureClose`).

### The one signature change

| | 0.28.1 | 0.29.0 |
|---|---|---|
| `encodeVenueFeeParams` | `((uint64 makerFeeBps,uint64 takerFeeBps,uint64 maxBuilderFeeBps,uint64 routingFeeBps,uint64 settlementFeeBps))` | `(…same five…, uint8 voidPolicy)` |
| selector | `0xdaf67cf3` | **`0x16899d27`** |
| source | `v28/…/src/operatorAbi.ts:12` | `src/operatorAbi.ts:35` |

The struct grew a `voidPolicy` field and `FEE_PARAMS_VERSION` went 2 → 3 (live
value on Shannon is 3). The decoder is backward-compatible with v2 payloads
(192 vs 224 bytes, `src/operatorReads.ts:23-30`), so **reads** of old venues
still work; a **write** built against the old tuple targets a dead selector.
This is the only change that can break a caller.

### Additive ABI surface new in 0.29.0

* `binaryPoolWriteAbi`: `captureClose(uint256 maxSteps)` — permissionless
  closing-price capture, plus `closingPrice()` / `closingTop(uint256)` reads
  (`src/tradeAbi.ts:50-55`, `src/readsAbi.ts:60-61`). This is the machinery
  behind the new `CLOB_SNAPSHOT` void policy.
* `binaryMarketReadAbi`: `voidPolicy()` (`src/readsAbi.ts:126`) — snapshot-
  generation markets only; older clones lack the selector.
* `oracleAdapterReadAbi`: `pullNumericAnswer` / `PRICE_DECIMALS`
  (`src/moduleAbi.ts:61-64`) — new, and directly relevant to §6's scale question.
* `marketCreatorV2Abi` — the whole interval/bucket-mode creator
  (`src/machineryAbi.ts:183-226`), plus `MarketCreatorPolicy.swapCreator`
  (`:235`). MarketCreatorV2 **drops** `triggerRoll`, `cancelSubscription(uint256)`,
  `firstRollArmed`, `armedBoundary` and adds the permissionless `recoverSeries`.
  This does not break v1 users, but it is the direction of travel.
* Spot stop-registry lifecycle events; a large perp linked-wallet read surface;
  `spotPoolOperatorRegistryReadAbi`.

### Behaviour that did **not** change

Revert handling: identical `receipt.status === "reverted"` throws in both
versions (`v28/…/src/writer.ts:586,612` vs `src/writer.ts:618,644`).

---

## Claims to correct

The design doc was written against 0.28.1. Against the 0.29.0 source:

| Claim | Verdict | Why |
|---|---|---|
| *"`mintSet` costs no fee and is an exact 1:1 identity"* | **Holds.** | `mintSet(yesTo,noTo,amount)` takes no fee argument and the pool comment is unambiguous: pulls `amount` collateral, mints `amount` YES + `amount` NO (`src/tradeAbi.ts:64-66`). No fee stream is charged at mint — `ProtocolFeeRecord` is per-*fill* (`src/fees.ts:27-53`), `SettlementFeeRecord` is skimmed at finalize (`src/eventsAbi.ts:300-306`). Live DreamDEX pool has all four fee rates at 0 anyway. **Caveat:** `burnSet` refunds *"via the pool's vault"* (`src/tradeAbi.ts:67-68`) — with a payout that falls back to vault credit you may need `withdraw(token, amount)` on the pool's `IERC20Vault` surface (`src/tradeAbi.ts:200-205`) to get the collateral into the vault's wallet. Budget for that in KeelVault. |
| *"the market creator defaults to the protocol's single approved oracle adapter; there is nothing to mint or arm per operator"* | **Holds.** | Stated verbatim at `src/marketCreatorAdmin.ts:58-63`; reinforced at `src/machineryAbi.ts:239-243`, `src/binary/plugin.ts:5-7`, `src/preflight.ts:12-16`. Live: `approvedAdapters(oracleHub)` → `true`. **But** it is not cost-free: every create attaches `getSchedulingCost(def) + resolveReserve()` in native, live-measured at **0.2 STT** reserve per market, paid from the MarketCreator's own float (`src/oracleHub.ts:296-306`, `src/binary/plugin.ts:30-35`). |
| *"the protocol rejects any interval below 60 seconds"* | **Holds.** | `MIN_SERIES_INTERVAL_SEC = 60` (`src/preflight.ts:74`); `registerSeries` doc says the module reverts `InvalidSeriesConfig` below 60 (`src/marketCreatorAdmin.ts:133`, `:334-335`); the error is in the generated table (`src/contractErrorsAbi.ts:230`). Note the SDK does **not** pre-validate — the revert comes from the chain. |
| *"every order carries a mandatory expiry"* | **Holds, and is stricter than stated.** | Not merely mandatory: `0 < expireNs <= pool.marketExpiryNs()`, else `OrderExpiryBeyondMarket` (`src/orders.ts:1041-1047`, `src/trade.ts:184-196`). There is **no GTC** on binary. The corollary the doc should add: expiry is **lazy** — an expired order keeps resting with no event and its escrow stays locked until a cancel or a permissionless sweep (`src/orders.ts:423-425`, `src/tradeAbi.ts:42-49`). |
| *"`triggerRoll` is a plain owner-called function that rolls the series manually"* | **WRONG — three ways.** | (1) It **calls the Somnia reactivity precompile** and arms the automatic roll loop; it *"only succeeds on testnet/mainnet, not local anvil"* (`src/marketCreatorAdmin.ts:343-350`, `src/machineryAbi.ts:140-141`) — so it is not testable on a local fork, and the creator's `setReactivityGasParams` must be set first. (2) It is **V1-only**: `MarketCreatorV2` dropped the selector entirely; its one start path is `armFirstRoll(seriesId, firesAtSec)` and stalls are handled by the permissionless `recoverSeries` (`src/machineryAbi.ts:169-186`). (3) It is **not free**: it needs the creator pre-funded with native for reactivity gas *plus* the oracle create value. |

### Two further corrections the doc will need

* **`Market.winningOutcome` on-chain no longer exists.** `winningOutcome()` was
  removed and *reverts* on the deployed BinaryMarket; derive the winner as
  `argmax(payoutNumerators())` gated on `isResolved()`, and check `isVoided()`
  separately (`src/tradeAbi.ts:373-376`, `src/binary/settlement.ts:46-57`,
  `src/markets.ts:1911-1918`). The indexer field of the same name still exists
  and is still 0 = Up.
* **`placeOrder` reverts on a binary pool.** Any code (or plan) that calls the
  generic `placeOrder(bool isBid, …)` against a BinaryPool gets
  `UseBinaryPlacement`. The binary entry point is `placeBinaryOrder`, the side is
  an explicit `kind` enum, and `userData` no longer encodes the side
  (`src/tradeAbi.ts:25-32`, `src/writer.ts:758-761`).

---

## Appendix — Keel-specific gotchas extracted from the source

1. **A pool address does not identify a market.** Pools are recycled across
   successive markets (never concurrently). Key everything by `bytes32 marketId`;
   use `(pool, marketNonce)` to say *which* of a pool's markets an outcome id
   belongs to (`src/markets.ts:1121-1131`, `src/ids.ts:3-15`). Cache invalidation
   in the SDK is keyed `(pool, nonce)` for exactly this reason
   (`src/writer.ts:700-714`) — KeelVault must do the same or it will quote into a
   dead market's ids after a roll.
2. **Re-quoting after a roll** means: `finalizeMarket(marketId)` →
   `redeem(...)` the winning leg → `burnSet` any leftover complete sets →
   read the successor market's `pool` + `marketNonce` → recompute `yesId`/`noId`
   → `mintSet` → `placeBinaryOrder` ×2. `releasePool(marketId)` returns the
   drained pool to the creator's free list so the next roll can recycle it.
3. **`booksEmpty()`** (`src/readsAbi.ts:52`) gates pool release — Keel's own
   resting orders can block a roll's pool recycle if not cancelled/swept.
4. **`captureClose(maxSteps)`** is new in 0.29.0 and self-incentivised: on a
   `CLOB_SNAPSHOT`-policy pool, post-expiry removal of orders that were alive at
   the close reverts `CloseNotCaptured` until someone captures
   (`src/tradeAbi.ts:50-55`, `src/trade.ts:351-380`). A market maker reclaiming
   escrow is exactly the party who must call it. Budget `maxSteps` (0 = pool
   default 256) and retry on `CaptureStepsExhausted`.
5. **Payout fallback.** If a payout push to KeelVault reverts, the collateral is
   credited rather than transferred and must be pulled with
   `BinarySettlement.claimOwed(token)` or the pool vault's `withdraw(token, amount)`
   (`src/readsAbi.ts:93`, `src/tradeAbi.ts:174-205`). Give KeelVault a `receive()`
   or plan to call the pull path.
6. **A tUSDC binary pool rejects native deposits** — `depositNative` into it
   reverts `InvalidDepositOrWithdrawal` (verified live per
   `src/tradeAbi.ts:186-189`).
