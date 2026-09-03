// Chain access for the console: plain JSON-RPC for reads, the injected wallet for
// writes. No library, no bundler.
//
// The console never sees a private key and never asks for one. Reads go straight to
// the public RPC; every write is handed to the wallet extension, which shows the
// user what they are signing and can refuse. That is the only arrangement in which
// a web page belongs anywhere near this protocol.

import { encodeCall, decode, namedError } from "./abi.js";

export const SHANNON = {
  chainId: 50312,
  chainIdHex: "0xc488",
  name: "Somnia Shannon",
  rpc: "https://dream-rpc.somnia.network",
  explorer: "https://shannon-explorer.somnia.network",
  currency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
};

let rpcId = 0;

async function rpc(method, params = [], url = SHANNON.rpc) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const json = await res.json();
  if (json.error) {
    const err = new Error(json.error.message ?? "rpc error");
    err.data = json.error.data;
    throw err;
  }
  return json.result;
}

/// A read. `signature` is canonical, `returns` an array of ABI types.
export async function read(to, signature, args = [], returns = ["uint256"]) {
  const data = await rpc("eth_call", [{ to, data: encodeCall(signature, args) }, "latest"]);
  const values = decode(returns, data);
  return returns.length === 1 ? values[0] : values;
}

/// A read that answers `null` instead of throwing, for panels that should degrade
/// to "unknown" rather than take the whole page down with them.
export async function tryRead(to, signature, args = [], returns = ["uint256"]) {
  try {
    return await read(to, signature, args, returns);
  } catch {
    return null;
  }
}

export const getBalance = (address) => rpc("eth_getBalance", [address, "latest"]).then((h) => BigInt(h));
export const getCode = (address) => rpc("eth_getCode", [address, "latest"]);

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export const hasWallet = () => typeof window !== "undefined" && !!window.ethereum;

async function request(method, params) {
  if (!hasWallet()) throw new Error("No wallet extension found in this browser.");
  return window.ethereum.request({ method, params });
}

export async function connect() {
  const accounts = await request("eth_requestAccounts", []);
  if (!accounts?.length) throw new Error("The wallet returned no accounts.");
  return accounts[0];
}

/// Passive wallet reads, bounded in time.
///
/// A locked or busy wallet does not always reject — measured here, it simply never
/// answers. `try/catch` is no defence against a promise that never settles: the load
/// path awaits it forever, and every live panel on the page stays empty while the
/// chain itself was reachable the whole time. So these two race the wallet against a
/// short clock and treat silence as "not connected", which is what it means.
///
/// Only the passive reads are bounded. `connect`, `send` and `deploy` are things the
/// user deliberately started and may sit in the wallet's UI for minutes.
const PASSIVE_TIMEOUT_MS = 2500;

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]).catch(() => fallback);
}

export async function currentAccount() {
  if (!hasWallet()) return null;
  const accounts = await withTimeout(request("eth_accounts", []), PASSIVE_TIMEOUT_MS, null);
  return accounts?.[0] ?? null;
}

export async function currentChainId() {
  if (!hasWallet()) return null;
  const id = await withTimeout(request("eth_chainId", []), PASSIVE_TIMEOUT_MS, null);
  return id === null ? null : Number(id);
}

/// Move the wallet to Shannon, adding the network first if it does not know it.
export async function switchToShannon() {
  try {
    await request("wallet_switchEthereumChain", [{ chainId: SHANNON.chainIdHex }]);
  } catch (err) {
    // 4902 is "unrecognised chain": the wallet has never heard of Shannon, so offer
    // to add it rather than leaving the user to copy RPC details by hand.
    if (err?.code === 4902 || /unrecognized|not been added/i.test(err?.message ?? "")) {
      await request("wallet_addEthereumChain", [
        {
          chainId: SHANNON.chainIdHex,
          chainName: SHANNON.name,
          rpcUrls: [SHANNON.rpc],
          nativeCurrency: SHANNON.currency,
          blockExplorerUrls: [SHANNON.explorer],
        },
      ]);
      return;
    }
    throw err;
  }
}

const hexValue = (v) => (v === undefined || v === null ? undefined : `0x${BigInt(v).toString(16)}`);

/// Simulate before sending, so a transaction that would revert is refused here with
/// the contract's own error name instead of costing gas to discover.
///
/// One exception is load-bearing: anything ending in Somnia's reactivity precompile
/// cannot be simulated at all — `eth_call` returns empty revert data even when the
/// transaction would succeed. `allowUnsimulatable` says "a revert carrying no data
/// is the precompile, not a rule I broke", the same distinction `scripts/launch.mjs`
/// draws after a live transaction proved it.
export async function preflight(tx, { errors = [], allowUnsimulatable = false } = {}) {
  try {
    await rpc("eth_call", [{ from: tx.from, to: tx.to, data: tx.data, value: hexValue(tx.value) }, "latest"]);
    return { ok: true };
  } catch (err) {
    const named = namedError(err.data, errors);
    if (named) return { ok: false, error: named };
    if (allowUnsimulatable) return { ok: true, unsimulatable: true };
    return { ok: false, error: null, message: err.message };
  }
}

/// Send a transaction through the wallet and wait for it to be mined.
export async function send(tx) {
  const hash = await request("eth_sendTransaction", [
    {
      from: tx.from,
      to: tx.to,
      data: tx.data,
      ...(tx.value !== undefined ? { value: hexValue(tx.value) } : {}),
      ...(tx.gas !== undefined ? { gas: hexValue(tx.gas) } : {}),
    },
  ]);
  return { hash, receipt: await waitForReceipt(hash) };
}

/// Deploy a contract: a transaction with no `to`, bytecode plus encoded arguments.
export async function deploy(from, bytecode, constructorSignature, args, gas) {
  const encoded = constructorSignature ? encodeCall(constructorSignature, args).slice(10) : "";
  const hash = await request("eth_sendTransaction", [
    { from, data: bytecode + encoded, ...(gas !== undefined ? { gas: hexValue(gas) } : {}) },
  ]);
  const receipt = await waitForReceipt(hash);
  return { hash, receipt, address: receipt.contractAddress };
}

export async function waitForReceipt(hash, { timeoutMs = 180_000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      // `status` is a hex string here, and comparing it to a number silently never
      // matches — the same trap that makes every failed transaction read as a
      // success. Compare against the string.
      if (receipt.status !== "0x1") {
        const err = new Error("Transaction reverted");
        err.receipt = receipt;
        err.hash = hash;
        throw err;
      }
      return receipt;
    }
    if (Date.now() > deadline) throw new Error(`Transaction ${hash} was not mined within three minutes.`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const txUrl = (hash) => `${SHANNON.explorer}/tx/${hash}`;
export const addressUrl = (a) => `${SHANNON.explorer}/address/${a}`;

export function onWalletChange(handler) {
  if (!hasWallet()) return;
  window.ethereum.on?.("accountsChanged", handler);
  window.ethereum.on?.("chainChanged", handler);
}
