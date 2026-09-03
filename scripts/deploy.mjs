#!/usr/bin/env node
// `npm run deploy` — puts Keel on Shannon in one command.
//
// Three transactions, in this order and for this reason:
//   1. KeelFactory              — Keel's control plane.
//   2. factory.bootstrap(...)   — operator, venue, market creator, allowlist. One
//                                 transaction or none: a half-run leaves a venue
//                                 that reads as live and refuses every roll.
//   3. KeelVault                — the underwriter, pointed at the same collateral.
//
// Prints a plan and stops unless `--confirm` is passed, because every step here
// spends real testnet gas and step 2 cannot be undone or re-run.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = `${ROOT}contracts/out`;

// Live-verified on Shannon 2026-09-01; see docs/SDK-0.29.0-VERIFIED.md §7.
const SHANNON = {
  chainId: 50312,
  binaryModule: "0x3ecC694Cef705358864a646142ac17A90E29e388",
  marketsCore: "0x2802504314685D89bF6C992CA5a8e7cC78bc0294",
  marketCreatorFactory: "0xE6bEE93cE87c9E6e62aCb621caa7832EE47b4F6B",
  oracleHub: "0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b",
  collateral: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E", // tUSDC
};

// The tick grid every market this creator mints inherits. 1000 raw at 6 decimals
// is 0.001 = 0.1% probability, matching DreamDEX's own defaultBookParams.
const BOOK = { tickSize: 1000n, minQuantity: 1000n, lotSize: 1000n };

const WAD = 10n ** 18n;
const wad = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

// Mirrors worker/spreadPolicy.js DEFAULT_CONFIG, which is itself tested against
// the Solidity library's own reference values.
const SPREAD_CONFIG = {
  baseSpread: wad(0.015),
  minSpread: wad(0.005),
  maxSpread: wad(0.08),
  refTau: 900n,
  skewCoef: wad(0.5),
  maxUrgencyMult: 6n * WAD,
};

function loadEnv() {
  const env = { ...process.env };
  const path = `${ROOT}.env`;
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].trim();
    }
  }
  return env;
}

function artifact(name) {
  const path = `${OUT}/${name}.sol/${name}.json`;
  if (!existsSync(path)) {
    console.error(`Missing ${path}. Build first:  forge build --root contracts`);
    process.exit(1);
  }
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

const env = loadEnv();
const confirm = process.argv.includes("--confirm");
// Re-deploy only the vault, against the venue an earlier run already bootstrapped.
// `bootstrap` cannot be re-run — it mints an operator and venue, and the reactivity
// bond that makes them usable is not refundable — so a vault fix must not require
// standing the whole control plane up again.
const vaultOnly = process.argv.includes("--vault-only");

if (!env.DEPLOYER_PRIVATE_KEY) {
  console.error("DEPLOYER_PRIVATE_KEY is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
// The quoter is the hot key; the deployer is the cold one. They must be different
// addresses or the separation the whole threat model rests on is cosmetic.

const { createWalletClient, createPublicClient, http, defineChain } = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");

const shannon = defineChain({
  id: SHANNON.chainId,
  name: "Somnia Shannon",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [env.RPC_URL ?? "https://dream-rpc.somnia.network"] } },
});

const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const quoter = env.QUOTER_ADDRESS
  ?? (env.BOT_PRIVATE_KEY ? privateKeyToAccount(env.BOT_PRIVATE_KEY).address : null);
if (quoter && quoter.toLowerCase() === account.address.toLowerCase()) {
  console.error("DEPLOYER_PRIVATE_KEY and BOT_PRIVATE_KEY are the same wallet.");
  console.error("The vault's guarantee is that the hot key cannot withdraw. Use two keys.");
  process.exit(1);
}
if (!quoter) {
  console.error("Set BOT_PRIVATE_KEY (or QUOTER_ADDRESS) — the vault needs a quoter distinct from its owner.");
  process.exit(1);
}
const publicClient = createPublicClient({ chain: shannon, transport: http() });
const wallet = createWalletClient({ account, chain: shannon, transport: http() });

const balance = await publicClient.getBalance({ address: account.address });
const quoterAddress = quoter;

console.log("Keel deploy plan");
console.log("----------------");
console.log(`  network      Shannon (${SHANNON.chainId})`);
console.log(`  deployer     ${account.address}`);
console.log(`  balance      ${Number(balance) / 1e18} STT`);
console.log(`  collateral   ${SHANNON.collateral} (tUSDC)`);
console.log(`  quoter key   ${quoterAddress}`);
console.log("");
if (vaultOnly) {
  console.log("  --vault-only: reusing the existing factory, operator and venue.");
  console.log("  1. deploy KeelVault");
} else {
  console.log("  1. deploy KeelFactory");
  console.log("  2. factory.bootstrap  -> operator, venue, market creator, allowlist");
  console.log("  3. deploy KeelVault");
}
console.log("");

if (balance < 10n ** 17n) {
  console.error("Under 0.1 STT. Fund the deployer before running this.");
  process.exit(1);
}
if (!confirm) {
  console.log("Dry run. Re-run with --confirm to send these transactions.");
  process.exit(0);
}

// `receipt.status` is viem's *string* union — comparing it to 1 silently never
// matches and every failed transaction reads as a success.
async function send(hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    console.error(`${label} reverted: ${hash}`);
    process.exit(1);
  }
  return receipt;
}

const factoryArt = artifact("KeelFactory");
const vaultArt = artifact("KeelVault");

let factory, venueId, marketCreator, creatorPolicy, operatorId;

if (vaultOnly) {
  const prior = JSON.parse(readFileSync(`${ROOT}deployments/shannon.json`, "utf8"));
  ({ KeelFactory: factory, marketCreator, creatorPolicy } = prior.contracts);
  ({ venueId } = prior);
  operatorId = BigInt(prior.operatorId);
  console.log(`1/1 reusing factory ${factory}, venue ${venueId.slice(0, 12)}…`);
} else {

console.log("1/3 deploying KeelFactory...");
const factoryHash = await wallet.deployContract({
  abi: factoryArt.abi,
  bytecode: factoryArt.bytecode,
  args: [SHANNON.marketsCore, SHANNON.binaryModule, SHANNON.marketCreatorFactory, SHANNON.oracleHub],
});
const factoryReceipt = await send(factoryHash, "KeelFactory deploy");
factory = factoryReceipt.contractAddress;
console.log(`    ${factory}`);

console.log("2/3 bootstrapping operator + venue + creator...");
const bootstrapHash = await wallet.writeContract({
  address: factory,
  abi: factoryArt.abi,
  functionName: "bootstrap",
  args: [
    account.address, // fee recipient
    0n, // makerFeeBps — zero to match DreamDEX's own venue while Keel is proving itself
    0n, // takerFeeBps
    env.VENUE_POLICY_SEED ?? "0x0000000000000000000000000000000000000000",
    BOOK,
  ],
});
await send(bootstrapHash, "bootstrap");
[venueId, marketCreator, creatorPolicy, operatorId] = await Promise.all([
  publicClient.readContract({ address: factory, abi: factoryArt.abi, functionName: "venueId" }),
  publicClient.readContract({ address: factory, abi: factoryArt.abi, functionName: "marketCreator" }),
  publicClient.readContract({ address: factory, abi: factoryArt.abi, functionName: "creatorPolicy" }),
  publicClient.readContract({ address: factory, abi: factoryArt.abi, functionName: "operatorId" }),
]);
console.log(`    venue    ${venueId}`);
console.log(`    creator  ${marketCreator}`);

}

console.log(`${vaultOnly ? "1/1" : "3/3"} deploying KeelVault...`);
const vaultHash = await wallet.deployContract({
  abi: vaultArt.abi,
  bytecode: vaultArt.bytecode,
  args: [
    SHANNON.collateral,
    SHANNON.binaryModule,
    // The venue minted in step 2. The vault will register pools from this venue and
    // no other — it is checked against the module, not against the pool's own word.
    venueId,
    quoterAddress,
    account.address,
    1000n, // 10% performance fee, above a high-water mark
    SPREAD_CONFIG,
  ],
});
const vaultReceipt = await send(vaultHash, "KeelVault deploy");
const vault = vaultReceipt.contractAddress;
console.log(`    ${vault}`);

const record = {
  network: "shannon",
  chainId: SHANNON.chainId,
  deployedAt: new Date().toISOString(),
  deployer: account.address,
  contracts: { KeelFactory: factory, KeelVault: vault, marketCreator, creatorPolicy },
  venueId,
  operatorId: Number(operatorId),
  protocol: SHANNON,
};
mkdirSync(`${ROOT}deployments`, { recursive: true });
writeFileSync(`${ROOT}deployments/shannon.json`, `${JSON.stringify(record, null, 2)}\n`);

console.log("");
console.log("Written to deployments/shannon.json. Next:");
console.log(`  KEEL_VENUE_ID=${venueId} KEEL_VAULT_ADDRESS=${vault} node worker/quoter.js`);
