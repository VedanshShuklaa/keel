#!/usr/bin/env node
// `npm run setup` — everything needed to go from a fresh clone to a green test run.
// Idempotent: safe to re-run. Never touches an existing .env.

import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const run = (cmd, opts = {}) => {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
};

const step = (n, msg) => console.log(`\n[${n}/4] ${msg}`);

// Solidity dependencies are vendored by clone rather than committed, so the repo
// stays small. Pinned to a tag: a moving dependency makes a green test run
// unreproducible.
const SOLIDITY_DEPS = [
  { name: "forge-std", repo: "https://github.com/foundry-rs/forge-std", tag: "v1.9.6" },
  { name: "solady", repo: "https://github.com/Vectorized/solady", tag: "v0.1.26" },
];

step(1, "Node dependencies");
run("npm install --silent");

step(2, "Solidity dependencies");
mkdirSync("contracts/lib", { recursive: true });
for (const dep of SOLIDITY_DEPS) {
  const path = `contracts/lib/${dep.name}`;
  if (existsSync(path)) {
    console.log(`  ${dep.name} already present, skipping`);
    continue;
  }
  run(`git clone --depth 1 --branch ${dep.tag} --quiet ${dep.repo} ${path}`);
}

step(3, "Configuration");
if (existsSync(".env")) {
  console.log("  .env already exists, leaving it alone");
} else {
  copyFileSync(".env.example", ".env");
  console.log("  created .env from .env.example");
}
mkdirSync("data/cache", { recursive: true });

step(4, "Verifying");
try {
  run("node scripts/doctor.mjs");
} catch {
  // doctor exits non-zero when something still needs the human; that is not a
  // setup failure, and its own output already says exactly what to do.
}

console.log(`
Setup done. Next:

  npm test            run the full suite (Node unit tests + Foundry contract tests)
  npm run chainstate  regenerate the live market-structure evidence (no wallet needed)
  npm run backtest    score the pricing model against settled windows (no wallet needed)

Everything above works with no private key. To send transactions, put two
throwaway keys in .env and claim testnet gas at https://testnet.somnia.network
`);
