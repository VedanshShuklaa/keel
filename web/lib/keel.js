// Every on-chain action the CLI can take, expressed once, so the interface and the
// scripts cannot disagree about what a button does.
//
// Each write carries the list of custom errors its contract can raise. That is what
// lets the console say "AlreadyLaunched — series 1 already covers SOL at 300s"
// instead of "transaction reverted", and it is most of the difference between an
// interface a stranger can use and one only its author can.

import { encodeCall } from "./abi.js";
import { read, tryRead, preflight, send, getBalance } from "./chain.js";

// Live-verified on Shannon; see docs/SDK-0.29.0-VERIFIED.md.
export const PROTOCOL = {
  binaryModule: "0x3ecC694Cef705358864a646142ac17A90E29e388",
  marketsCore: "0x2802504314685D89bF6C992CA5a8e7cC78bc0294",
  marketCreatorFactory: "0xE6bEE93cE87c9E6e62aCb621caa7832EE47b4F6B",
  oracleHub: "0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b",
  collateral: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
  collateralSymbol: "tUSDC",
  collateralDecimals: 6,
};

export const FACTORY_ERRORS = [
  "AlreadyBootstrapped()",
  "NotBootstrapped()",
  "AlreadyLaunched(uint32)",
  "IntervalOutOfRange()",
  "SettlementWindowTooShort()",
  "InvalidAsset()",
  "InsufficientLaunchValue(uint256)",
  "ZeroAddress()",
  "FeeTooHigh()",
  "FundingFailed()",
  "CreatorNotAllowlisted()",
  "UnknownSeries(uint32)",
  "Unauthorized()",
];

export const VAULT_ERRORS = [
  "NotQuoter()",
  "NotFlat()",
  "ZeroAmount()",
  "NothingToClaim()",
  "PoolNotRegistered()",
  "PoolAlreadyRegistered()",
  "PoolNotFlat()",
  "InsufficientInventory()",
  "OrderRejected()",
  "FeeTooHigh()",
  "WindowNotExpired()",
  "NotResolved()",
  "InvalidQuote()",
  "PoolParamsUnreadable()",
  "PoolNotInMarket()",
  "PoolNotFromOurVenue()",
  "WrongCollateral()",
  "WindowExpired()",
  "DepositTooSmall(uint256)",
  "Unauthorized()",
];

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function fmtUnits(value, decimals, places = 2) {
  if (value === null || value === undefined) return "—";
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, places);
  return places ? `${whole.toLocaleString()}.${frac}` : whole.toLocaleString();
}

export const fmtStt = (wei, places = 2) => fmtUnits(wei, 18, places);

/// Full precision with trailing zeros trimmed. Used where rounding to two places
/// would print a limit as "0.00" and make the message nonsense.
export function fmtExact(value, decimals) {
  const full = fmtUnits(value, decimals, decimals);
  return full.includes(".") ? full.replace(/0+$/, "").replace(/\.$/, "") : full;
}
export const toRaw = (amount, decimals) => BigInt(Math.round(Number(amount) * 10 ** decimals));

/// Plain-language readings of the reverts a user can actually cause. Anything not
/// listed falls back to the raw error name, which still beats "it reverted".
export const ERROR_HELP = {
  AlreadyLaunched: (a) =>
    `That series already exists — it is series ${a[0]}. Pick a different asset, or a different window length.`,
  InsufficientLaunchValue: (a) =>
    `This launch needs ${fmtStt(a[0])} STT attached. Faster windows cost more, because they consume the shared float faster.`,
  IntervalOutOfRange: () => "Window length must be between 60 seconds and 7 days.",
  SettlementWindowTooShort: () => "The settlement window must be at least 60 seconds.",
  InvalidAsset: () => "Ticker must be 1–16 uppercase letters or digits — no slash, no pair, just the base symbol.",
  NotBootstrapped: () => "This factory has not been bootstrapped yet. Do that first.",
  AlreadyBootstrapped: () => "This factory is already bootstrapped. Bootstrap runs once and cannot be repeated.",
  UnknownSeries: (a) => `There is no series ${a[0]} on this factory.`,
  NotQuoter: () =>
    "Only the vault's quoter key can do that. Connect the quoter wallet, or have the owner point the vault at this one.",
  NotFlat: () =>
    "The vault still holds open orders or positions. Cancel, reclaim and redeem first — the share price is only struck when it is flat.",
  DepositTooSmall: (a) =>
    `Minimum deposit is ${fmtExact(a[0], PROTOCOL.collateralDecimals)} ${PROTOCOL.collateralSymbol}. Dust deposits exist to manufacture a tiny share supply, not to underwrite anything.`,
  ZeroAmount: () => "Amount must be greater than zero.",
  NothingToClaim: () => "Nothing is waiting to be claimed on this wallet.",
  PoolNotRegistered: () => "The vault has not registered this market yet.",
  PoolAlreadyRegistered: () => "The vault has already registered this market.",
  PoolNotInMarket: () =>
    "The module does not list that pool for that market id. The vault only registers pools it can verify.",
  PoolNotFromOurVenue: () => "That market is on another venue. This vault only underwrites books Keel launched.",
  WrongCollateral: () => "That market settles in a different token from the vault's collateral.",
  WindowExpired: () => "That window has already expired — the vault will not mint into it.",
  InsufficientInventory: () => "Not enough free collateral, or not enough matched inventory, for that size.",
  OrderRejected: () =>
    "The exchange rejected the order. A post-only quote that would cross the book comes back rejected rather than reverting.",
  InvalidQuote: () =>
    "The quote failed the solvency invariant: both legs must sell for more than the complete set costs to mint.",
  NotResolved: () => "The oracle has not resolved this market yet.",
  WindowNotExpired: () => "The window is still live — escrow can only be reclaimed once it has expired.",
  Unauthorized: () => "This wallet does not own that contract.",
  Error: (a) => a[0] ?? "The contract rejected the call.",
};

export const explainError = (named) => {
  if (!named) return null;
  const help = ERROR_HELP[named.name];
  return help ? help(named.args) : `${named.name}${named.args.length ? `(${named.args.join(", ")})` : ""}`;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const factory = {
  bootstrapped: (a) => tryRead(a, "bootstrapped()", [], ["bool"]),
  venueId: (a) => tryRead(a, "venueId()", [], ["bytes32"]),
  marketCreator: (a) => tryRead(a, "marketCreator()", [], ["address"]),
  owner: (a) => tryRead(a, "owner()", [], ["address"]),
  seriesCount: (a) => tryRead(a, "seriesCount()"),
  creatorFloat: (a) => tryRead(a, "creatorFloat()"),
  launchCostFor: (a, intervalSec) => read(a, "launchCostFor(uint64)", [BigInt(intervalSec)]),
};

export const vault = {
  asset: (a) => tryRead(a, "asset()", [], ["address"]),
  owner: (a) => tryRead(a, "owner()", [], ["address"]),
  quoter: (a) => tryRead(a, "quoter()", [], ["address"]),
  epoch: (a) => tryRead(a, "epoch()", [], ["uint64"]),
  isFlat: (a) => tryRead(a, "isFlat()", [], ["bool"]),
  totalAssets: (a) => tryRead(a, "totalAssets()"),
  activePoolCount: (a) => tryRead(a, "activePoolCount()"),
  shares: (a, who) => tryRead(a, "balanceOf(address)", [who]),
  openOrders: (a, poolAddr) => tryRead(a, "openOrders(address)", [poolAddr], ["uint128[]"]),
  sharePrice: (a, epoch) => tryRead(a, "sharePrice(uint64)", [BigInt(epoch)]),
  pending: (a, who) => tryRead(a, "pendingOf(address)", [who], ["uint64", "uint128", "uint128"]),
  poolRow: (a, poolAddr) =>
    tryRead(
      a,
      "pools(address)",
      [poolAddr],
      ["bytes32", "uint256", "uint256", "uint256", "address", "address", "bool"],
    ),
};

export const token = {
  decimals: (a) => tryRead(a, "decimals()", [], ["uint8"]),
  balanceOf: (a, who) => tryRead(a, "balanceOf(address)", [who]),
  allowance: (a, owner, spender) => tryRead(a, "allowance(address,address)", [owner, spender]),
};

export const poolReads = {
  book: (a) => tryRead(a, "getOrderBookParameters()", [], ["uint256", "uint256", "uint256"]),
  finalized: async (a) => {
    const params = await tryRead(
      a,
      "getBinaryPoolParams()",
      [],
      [
        "address", "address", "address", "uint256", "uint256", "uint256", "uint256", "address",
        "uint256", "uint256", "uint256", "uint256", "address", "uint64", "bool",
      ],
    );
    return params ? params[14] : null;
  },
};

export { getBalance };

// ---------------------------------------------------------------------------
// Writes — each names the errors it can raise
// ---------------------------------------------------------------------------

/// Build, simulate, send. Throws an Error whose `.explained` is a sentence someone
/// who did not write the contracts can act on.
async function write(from, to, signature, args, { value, errors, allowUnsimulatable, gas } = {}) {
  const tx = { from, to, data: encodeCall(signature, args), value, gas };
  const check = await preflight(tx, { errors, allowUnsimulatable });
  if (!check.ok) {
    const err = new Error(check.message ?? "The transaction would revert.");
    err.explained = explainError(check.error) ?? check.message ?? "The transaction would revert.";
    throw err;
  }
  return send(tx);
}

export const actions = {
  bootstrap: (from, factoryAddr, { feeRecipient, makerFeeBps, takerFeeBps, seedPolicy, book }) =>
    write(
      from,
      factoryAddr,
      "bootstrap(address,uint256,uint256,address,(uint256,uint256,uint256))",
      [feeRecipient, BigInt(makerFeeBps), BigInt(takerFeeBps), seedPolicy, book],
      { errors: FACTORY_ERRORS, gas: 6_000_000n },
    ),

  launch: (from, factoryAddr, { asset, collateral, numericDecimals, intervalSec, settlementWindow, value }) =>
    write(
      from,
      factoryAddr,
      "launch(string,address,uint64,uint64,uint64)",
      [asset, collateral, BigInt(numericDecimals), BigInt(intervalSec), BigInt(settlementWindow)],
      {
        value,
        errors: FACTORY_ERRORS,
        // The first roll goes through the reactivity precompile, which `eth_call`
        // cannot reach. A dataless revert here is that, not a broken launch.
        allowUnsimulatable: true,
        gas: 300_000_000n,
      },
    ),

  refuel: (from, factoryAddr, value) => write(from, factoryAddr, "refuel()", [], { value, errors: FACTORY_ERRORS }),

  rearm: (from, factoryAddr, seriesId) =>
    write(from, factoryAddr, "rearm(uint32)", [BigInt(seriesId)], {
      errors: FACTORY_ERRORS,
      allowUnsimulatable: true,
      gas: 300_000_000n,
    }),

  approve: (from, tokenAddr, spender, amount) =>
    write(from, tokenAddr, "approve(address,uint256)", [spender, amount], { errors: [] }),

  requestDeposit: (from, vaultAddr, amount) =>
    write(from, vaultAddr, "requestDeposit(uint256)", [amount], { errors: VAULT_ERRORS }),

  requestRedeem: (from, vaultAddr, shares) =>
    write(from, vaultAddr, "requestRedeem(uint256)", [shares], { errors: VAULT_ERRORS }),

  claim: (from, vaultAddr) => write(from, vaultAddr, "claim()", [], { errors: VAULT_ERRORS }),

  rollEpoch: (from, vaultAddr) => write(from, vaultAddr, "rollEpoch()", [], { errors: VAULT_ERRORS }),

  registerPool: (from, vaultAddr, poolAddr, marketId) =>
    write(from, vaultAddr, "registerPool(address,bytes32)", [poolAddr, marketId], { errors: VAULT_ERRORS }),

  mintSets: (from, vaultAddr, poolAddr, amount) =>
    write(from, vaultAddr, "mintSets(address,uint256)", [poolAddr, amount], { errors: VAULT_ERRORS }),

  quote: (from, vaultAddr, poolAddr, fairValueWad, quantity) =>
    write(from, vaultAddr, "quote(address,uint256,uint256)", [poolAddr, fairValueWad, quantity], {
      errors: VAULT_ERRORS,
    }),

  cancelAll: (from, vaultAddr, poolAddr) =>
    write(from, vaultAddr, "cancelAll(address)", [poolAddr], { errors: VAULT_ERRORS }),

  reclaimExpired: (from, vaultAddr, poolAddr) =>
    write(from, vaultAddr, "reclaimExpired(address)", [poolAddr], { errors: VAULT_ERRORS }),

  burnSets: (from, vaultAddr, poolAddr, amount) =>
    write(from, vaultAddr, "burnSets(address,uint256)", [poolAddr, amount], { errors: VAULT_ERRORS }),

  finalize: (from, vaultAddr, poolAddr) =>
    write(from, vaultAddr, "finalize(address)", [poolAddr], { errors: VAULT_ERRORS }),

  redeemSettled: (from, vaultAddr, poolAddr) =>
    write(from, vaultAddr, "redeemSettled(address)", [poolAddr], { errors: VAULT_ERRORS }),
};
