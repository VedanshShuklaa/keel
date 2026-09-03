#!/usr/bin/env node
// `npm run launch -- SOL 300` — open a rolling Event Contract series on an asset
// that has none.
//
// This is the Launch half of Keel in one command. It calls `KeelFactory.launch`,
// which registers the series with Keel's own market creator and fires the first
// roll through Somnia's reactivity precompile. Every later window mints itself.
//
// The value attached is `factory.launchCost()` — read live from the oracle hub
// rather than hardcoded, because the hub owns that number and can change it.

import { readFileSync, existsSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;

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

const env = loadEnv();
const args = process.argv.slice(2).filter((a) => a !== "--confirm");
const confirm = process.argv.includes("--confirm");

const asset = (args[0] ?? "SOL").toUpperCase();
const intervalSec = BigInt(args[1] ?? 300);
const settlementWindow = BigInt(args[2] ?? 300);

const deployPath = `${ROOT}deployments/shannon.json`;
if (!existsSync(deployPath)) {
  console.error("No deployments/shannon.json. Deploy first:  npm run deploy -- --confirm");
  process.exit(1);
}
const dep = JSON.parse(readFileSync(deployPath, "utf8"));

if (!env.DEPLOYER_PRIVATE_KEY) {
  console.error("DEPLOYER_PRIVATE_KEY is not set.");
  process.exit(1);
}

const { createWalletClient, createPublicClient, http, defineChain, formatEther } = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");
// The build artifact rather than worker/abi.js: only the full ABI carries the
// error definitions, and a launch that fails should say *which* rule it broke.
const factoryAbi = JSON.parse(
  readFileSync(`${ROOT}contracts/out/KeelFactory.sol/KeelFactory.json`, "utf8"),
).abi;

const shannon = defineChain({
  id: dep.chainId,
  name: "Somnia Shannon",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [env.RPC_URL ?? "https://dream-rpc.somnia.network"] } },
});

const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain: shannon, transport: http() });
const wallet = createWalletClient({ account, chain: shannon, transport: http() });

const factory = dep.contracts.KeelFactory;
const collateral = dep.protocol.collateral;

const [cost, float, count, balance] = await Promise.all([
  // Priced for *this* cadence: a faster series consumes the shared creator float
  // faster, so it pre-pays for more of it.
  publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "launchCostFor",
    args: [intervalSec],
  }),
  publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "creatorFloat" }),
  publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "seriesCount" }),
  publicClient.getBalance({ address: account.address }),
]);

console.log("Keel launch plan");
console.log("----------------");
console.log(`  asset            ${asset}`);
console.log(`  interval         ${intervalSec}s windows, ${settlementWindow}s settlement`);
console.log(`  collateral       ${collateral} (tUSDC)`);
console.log(`  factory          ${factory}`);
console.log(`  creator float    ${formatEther(float)} STT`);
console.log(`  series so far    ${count}`);
console.log("");
// The contract's `launchCost()` counts only the reserve leg. The oracle's real
// per-create value is `getSchedulingCost(def) + resolveReserve()` (SDK oracleHub.js
// :12-15), and the scheduling leg is quoted from a question definition the market
// creator builds internally — not something the factory can reconstruct on-chain.
// So the floor is enforced there and the true amount is attached here. Overpaying
// is safe in both directions: the hub refunds its excess in-tx, and whatever is
// left over stays in the creator's float and pays for later rolls.
const perRoll = BigInt(process.env.LAUNCH_VALUE_PER_ROLL ?? "1500000000000000000");
const value = perRoll * 4n > cost ? perRoll * 4n : cost;
console.log(`  floor            ${formatEther(cost)} STT  (oracle reserve x prefunded rolls)`);
console.log(`  attaching        ${formatEther(value)} STT  (reserve + scheduling, 4 rolls)`);
console.log(`  your balance     ${formatEther(balance)} STT`);
console.log("");

if (balance < value) {
  console.error("Not enough STT to cover the launch.");
  process.exit(1);
}
if (!confirm) {
  console.log("Dry run. Re-run with --confirm to send it.");
  process.exit(0);
}

// Simulate first, but only *named* reverts are a reason to stop. `launch` ends in
// `triggerRoll`, which calls Somnia's reactivity precompile to arm the roll loop,
// and that precompile is not reachable from `eth_call` — the simulation comes back
// with empty revert data even when the transaction would succeed. So: decode the
// revert; if it names one of the factory's own errors, abort and say which. If it
// carries no data at all, that is the precompile, and we send with an explicit gas
// cap (estimateGas is `eth_call` too, and would fail the same way).
const GAS_CAP = BigInt(process.env.LAUNCH_GAS ?? 20_000_000);
let request = null;
try {
  ({ request } = await publicClient.simulateContract({
    account,
    address: factory,
    abi: factoryAbi,
    functionName: "launch",
    args: [asset, collateral, 8n, intervalSec, settlementWindow],
    value,
  }));
} catch (err) {
  const named = err.cause?.data?.errorName;
  if (named) {
    console.error(`  ${named} — launch would revert. Nothing sent.`);
    process.exit(1);
  }
  console.log("  simulation returned no revert data (the reactivity precompile);");
  console.log(`  sending with an explicit ${GAS_CAP} gas cap.`);
}

const hash = request
  ? await wallet.writeContract(request)
  : await wallet.writeContract({
      address: factory,
      abi: factoryAbi,
      functionName: "launch",
      args: [asset, collateral, 8n, intervalSec, settlementWindow],
      value,
      gas: GAS_CAP,
    });
console.log(`  sent  ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
// viem's `status` is a *string* union; comparing it to 1 never matches.
if (receipt.status !== "success") {
  console.error("  launch reverted");
  process.exit(1);
}

const seriesCount = await publicClient.readContract({
  address: factory,
  abi: factoryAbi,
  functionName: "seriesCount",
});

console.log(`  mined in block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
console.log(`  ${asset} is live. Keel now runs ${seriesCount} series.`);
console.log("");
console.log("Next:");
console.log("  npm run quote     # rest two-sided quotes on every window it opens");
