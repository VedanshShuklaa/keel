#!/usr/bin/env node
// `npm run doctor` — one command that tells you whether this machine can run Keel,
// and if not, exactly what to do about it. Read-only: never sends a transaction.

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const checks = [];
const record = (name, ok, detail, fix) => checks.push({ name, ok, detail, fix });

function loadEnv() {
  const env = { ...process.env };
  if (!existsSync(".env")) return env;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function which(cmd, versionArg = "--version") {
  try {
    return execSync(`${cmd} ${versionArg}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString().split("\n")[0].trim();
  } catch {
    return null;
  }
}

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function gqlAlive(url) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ __typename }" }),
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok;
}

const env = loadEnv();

// --- toolchain ---
const major = Number(process.versions.node.split(".")[0]);
record("Node >= 20", major >= 20, `v${process.versions.node}`,
  "Install Node 20+ (nvm install 20). Native fetch and node:test are required.");

const forge = which("forge");
record("Foundry (forge)", Boolean(forge), forge ?? "not found",
  "curl -L https://foundry.paradigm.xyz | bash && foundryup");

record("node_modules installed", existsSync("node_modules"), existsSync("node_modules") ? "present" : "missing",
  "npm install");

// --- config ---
record(".env present", existsSync(".env"), existsSync(".env") ? "found" : "missing",
  "cp .env.example .env, then fill in two throwaway private keys.");

// Live-verified on Shannon; see docs/SDK-0.29.0-VERIFIED.md §7.
const TUSDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";

const keyFields = ["DEPLOYER_PRIVATE_KEY", "BOT_PRIVATE_KEY"];
const keysSet = keyFields.filter((k) => /^0x[0-9a-fA-F]{64}$/.test(env[k] ?? ""));
record("Signing keys", keysSet.length === 2,
  `${keysSet.length}/2 set (${keyFields.filter((k) => !keysSet.includes(k)).join(", ") || "all good"})`,
  "Generate throwaway keys with `cast wallet new`, paste into .env. Read-only commands work without these.");

// --- network ---
const rpcUrl = env.RPC_URL ?? "https://dream-rpc.somnia.network";
try {
  const chainId = Number(await rpc(rpcUrl, "eth_chainId"));
  const block = Number(await rpc(rpcUrl, "eth_blockNumber"));
  record("Shannon RPC", chainId === 50312, `chainId ${chainId}, block ${block}`,
    "Expected chain 50312. Check RPC_URL in .env.");
} catch (err) {
  record("Shannon RPC", false, err.message, `Cannot reach ${rpcUrl}. Check connectivity.`);
}

for (const [name, url] of [
  ["Indexer", env.INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql"],
  ["Price feed", env.PRICEFEED_URL ?? "https://price-feed.dev.oracle.somnia.host/v1/graphql"],
]) {
  try {
    record(name, await gqlAlive(url), url, "");
  } catch (err) {
    record(name, false, err.message, `Cannot reach ${url}.`);
  }
}

// --- funding (only when keys are present) ---
if (keysSet.length) {
  const { privateKeyToAccount } = await import("viem/accounts").catch(() => ({}));
  if (!privateKeyToAccount) {
    record("Wallet balances", false, "viem not installed", "npm install");
  } else {
    for (const field of keysSet) {
      const account = privateKeyToAccount(env[field]);
      try {
        const wei = BigInt(await rpc(rpcUrl, "eth_getBalance", [account.address, "latest"]));
        const stt = Number(wei) / 1e18;
        record(`Gas — ${field.replace("_PRIVATE_KEY", "")}`, stt >= 0.05,
          `${account.address} holds ${stt.toFixed(6)} STT`,
          "Claim gas at https://testnet.somnia.network. A re-quoting bot burns STT fast; 0.05 is the floor to start.");
      } catch (err) {
        record(`Gas — ${field.replace("_PRIVATE_KEY", "")}`, false, err.message, "");
      }

      // tUSDC is the vault's collateral. Gas alone gets you a deployment and no
      // market: without it there is nothing to mint a complete set out of.
      try {
        const data = `0x70a08231${account.address.slice(2).toLowerCase().padStart(64, "0")}`;
        const raw = await rpc(rpcUrl, "eth_call", [{ to: TUSDC, data }, "latest"]);
        const usdc = Number(BigInt(raw)) / 1e6;
        record(`tUSDC — ${field.replace("_PRIVATE_KEY", "")}`, usdc > 0,
          `${usdc.toFixed(2)} tUSDC`,
          `Claim tUSDC for ${account.address} at https://testnet.somnia.network. The vault has nothing to underwrite with until this is non-zero.`);
      } catch (err) {
        record(`tUSDC — ${field.replace("_PRIVATE_KEY", "")}`, false, err.message, "");
      }
    }
  }
}

// --- report ---
const pad = Math.max(...checks.map((c) => c.name.length));
console.log("\nKeel doctor\n");
for (const c of checks) {
  console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(pad)}  ${c.detail}`);
}
const failed = checks.filter((c) => !c.ok);
if (!failed.length) {
  console.log("\nAll checks passed. `npm test` next.\n");
  process.exit(0);
}
console.log("\nFix these:\n");
for (const c of failed) if (c.fix) console.log(`  ${c.name}\n    ${c.fix}\n`);
process.exit(1);
