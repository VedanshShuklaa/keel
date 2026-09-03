// Minimal ABIs for the contracts the quoter actually touches. Hand-written rather
// than pulled from `contracts/out/` so the worker runs from a fresh clone without
// a Foundry build, and so every signature here can be read against
// `docs/SDK-0.29.0-VERIFIED.md` without opening a JSON artifact.

export const keelVaultAbi = [
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "epoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "isFlat", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "totalAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "activePoolCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "openOrders",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [{ type: "uint128[]" }],
  },
  {
    type: "function",
    name: "registerPool",
    stateMutability: "nonpayable",
    inputs: [{ name: "pool", type: "address" }, { name: "marketId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "mintSets",
    stateMutability: "nonpayable",
    inputs: [{ name: "pool", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "quote",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "fairValueUp", type: "uint256" },
      { name: "quantity", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelAll",
    stateMutability: "nonpayable",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "reclaimExpired",
    stateMutability: "nonpayable",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "burnSets",
    stateMutability: "nonpayable",
    inputs: [{ name: "pool", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "finalize",
    stateMutability: "nonpayable",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "redeemSettled",
    stateMutability: "nonpayable",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [],
  },
  { type: "function", name: "pendingDepositAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "reservedAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  // `pools` is a public mapping to a struct, so the generated getter returns the
  // fields as a flat tuple in declaration order — not a single struct value.
  {
    type: "function",
    name: "pools",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "marketId", type: "bytes32" },
      { name: "outcomeUpId", type: "uint256" },
      { name: "outcomeDownId", type: "uint256" },
      { name: "oneCollateral", type: "uint256" },
      { name: "settlement", type: "address" },
      { name: "outcome", type: "address" },
      { name: "registered", type: "bool" },
    ],
  },
  { type: "function", name: "rollEpoch", stateMutability: "nonpayable", inputs: [], outputs: [] },
];

// See docs/SDK-0.29.0-VERIFIED.md §0. `getBinaryPoolParams` returns fifteen values;
// the ones the quoter reads are `oneCollateral` (index 5) and `finalized` (14).
export const binaryPoolAbi = [
  {
    type: "function",
    name: "getBinaryPoolParams",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "collateralToken", type: "address" },
      { name: "market", type: "address" },
      { name: "outcomeToken", type: "address" },
      { name: "yesId", type: "uint256" },
      { name: "noId", type: "uint256" },
      { name: "oneCollateral", type: "uint256" },
      { name: "setBacking", type: "uint256" },
      { name: "feeRecipient", type: "address" },
      { name: "makerFeeBpsTimes1k", type: "uint256" },
      { name: "takerFeeBpsTimes1k", type: "uint256" },
      { name: "maxBuilderFeeBpsTimes1k", type: "uint256" },
      { name: "settlementFeeBpsTimes1k", type: "uint256" },
      { name: "settlement", type: "address" },
      { name: "marketNonce", type: "uint64" },
      { name: "finalized", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "getOrderBookParameters",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "tickSize", type: "uint256" },
      { name: "minQuantity", type: "uint256" },
      { name: "lotSize", type: "uint256" },
    ],
  },
  { type: "function", name: "marketExpiryNs", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
];

export const keelFactoryAbi = [
  { type: "function", name: "bootstrapped", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "marketCreator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "venueId", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "operatorId", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "launchCost", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "launchCostFor",
    stateMutability: "view",
    inputs: [{ name: "intervalSec", type: "uint64" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "rearm",
    stateMutability: "nonpayable",
    inputs: [{ name: "seriesId", type: "uint32" }],
    outputs: [],
  },
  { type: "function", name: "seriesCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "creatorFloat", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "launch",
    stateMutability: "payable",
    inputs: [
      { name: "asset", type: "string" },
      { name: "collateral", type: "address" },
      { name: "numericDecimals", type: "uint64" },
      { name: "intervalSec", type: "uint64" },
      { name: "settlementWindow", type: "uint64" },
    ],
    outputs: [{ type: "uint32" }],
  },
];

export const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];

// ERC-6909. Outcome tokens are ids on one contract, so the vault's inventory in a
// market is two balances on the pool's `outcome` token.
export const outcome6909Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "id", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
];
