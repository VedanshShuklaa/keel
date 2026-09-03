import test from "node:test";
import assert from "node:assert/strict";

import { keccakHex, selector } from "../../web/lib/keccak.js";

// The console derives its own function selectors rather than carrying a hardcoded
// table, because a mistyped selector does not throw — it calls nothing, returns
// empty, and the interface shows a plausible zero. That only helps if the keccak
// underneath is right, so it is pinned here against the standard test vectors and
// against values produced by `cast sig`.

test("keccak256 matches the standard vectors", () => {
  assert.equal(keccakHex(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccakHex("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(
    keccakHex("The quick brown fox jumps over the lazy dog"),
    "0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15",
  );
});

test("keccak256 spans the 136-byte rate boundary", () => {
  for (const n of [134, 135, 136, 137, 200, 272]) {
    const h = keccakHex("a".repeat(n));
    assert.match(h, /^0x[0-9a-f]{64}$/, `well formed at ${n}`);
    assert.equal(h, keccakHex("a".repeat(n)), `deterministic at ${n}`);
  }
  // Inputs either side of a block boundary must not collide — the absorb loop's
  // padding is the easiest thing to get wrong and the hardest to notice.
  assert.notEqual(keccakHex("a".repeat(135)), keccakHex("a".repeat(136)));
  assert.notEqual(keccakHex("a".repeat(136)), keccakHex("a".repeat(137)));
});

// Every signature the console actually calls, against `cast sig`. If a contract's
// signature changes, this fails rather than the interface going quiet.
const SELECTORS = {
  // KeelFactory
  "bootstrap(address,uint256,uint256,address,(uint256,uint256,uint256))": "0x1f460005",
  "launch(string,address,uint64,uint64,uint64)": "0xaee0e8fe",
  "launchCostFor(uint64)": "0x7c0ccbae",
  "refuel()": "0x4c1ec9aa",
  "rearm(uint32)": "0xf9ba60c9",
  "seriesCount()": "0xd7f2c0ef",
  "series(uint32)": "0x16cfcd97",
  "creatorFloat()": "0xef947cdc",
  "bootstrapped()": "0x35142c8c",
  "venueId()": "0x9e15c572",
  "marketCreator()": "0x27cbaabe",
  "owner()": "0x8da5cb5b",
  // KeelVault
  "requestDeposit(uint256)": "0x0d1e6667",
  "requestRedeem(uint256)": "0xaa2f892d",
  "claim()": "0x4e71d92d",
  "rollEpoch()": "0xd6c0776e",
  "registerPool(address,bytes32)": "0xd852c8b6",
  "mintSets(address,uint256)": "0xbb71fd74",
  "quote(address,uint256,uint256)": "0x9e8cc04b",
  "cancelAll(address)": "0x97e8f717",
  "reclaimExpired(address)": "0x8861cbac",
  "burnSets(address,uint256)": "0xd7d40507",
  "finalize(address)": "0x4ef39b75",
  "redeemSettled(address)": "0xd9f89cc2",
  "openOrders(address)": "0x5808bb38",
  "isFlat()": "0xae37e931",
  "totalAssets()": "0x01e1d114",
  "epoch()": "0x900cf0cf",
  "asset()": "0x38d52e0f",
  "quoter()": "0xc6bbd5a7",
  "sharePrice(uint64)": "0xb28fe691",
  "pools(address)": "0xa4063dbc",
  "pendingOf(address)": "0xf44136a1",
  "activePoolCount()": "0x8348bce3",
  // ERC-20 and the pool
  "balanceOf(address)": "0x70a08231",
  "approve(address,uint256)": "0x095ea7b3",
  "allowance(address,address)": "0xdd62ed3e",
  "decimals()": "0x313ce567",
  "getBinaryPoolParams()": "0x9b98cc19",
  "getOrderBookParameters()": "0x0765910c",
};

test("every selector the console uses matches cast sig", () => {
  for (const [signature, expected] of Object.entries(SELECTORS)) {
    assert.equal(selector(signature), expected, signature);
  }
});
