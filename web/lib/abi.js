// A minimal ABI codec — just the types Keel's own surface uses.
//
// The console ships no bundler and no dependencies, so this is hand-written rather
// than pulled from a library. It covers static words (address, uintN, bool,
// bytes32), one dynamic type (string), static tuples, and dynamic arrays on the
// decode side. Anything outside that throws by name instead of encoding silently
// wrong, because a quietly malformed argument is the worst failure available here:
// the transaction still sends, and it does the wrong thing.

import { selector } from "./keccak.js";

const WORD = 64; // hex characters in one 32-byte word

const strip = (hex) => (hex.startsWith("0x") ? hex.slice(2) : hex);

function word(value) {
  const hex = value.toString(16);
  if (hex.length > WORD) throw new Error(`value does not fit in a word: ${value}`);
  return hex.padStart(WORD, "0");
}

function encodeAddress(a) {
  const clean = strip(a).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error(`not an address: ${a}`);
  return clean.padStart(WORD, "0");
}

function encodeBytes32(b) {
  const clean = strip(b).toLowerCase();
  if (!/^[0-9a-f]{1,64}$/.test(clean)) throw new Error(`not bytes32: ${b}`);
  return clean.padStart(WORD, "0");
}

function encodeString(s) {
  const bytes = new TextEncoder().encode(s);
  const body = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const padded = body.length ? body.padEnd(Math.ceil(body.length / WORD) * WORD, "0") : "";
  return word(BigInt(bytes.length)) + padded;
}

const isUint = (t) => /^uint\d*$/.test(t);
const isTuple = (t) => t.startsWith("(") && t.endsWith(")");

/// Split a tuple type into its component types, respecting nesting.
function tupleParts(type) {
  const inner = type.slice(1, -1);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "(") depth++;
    else if (inner[i] === ")") depth--;
    else if (inner[i] === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (inner.length) parts.push(inner.slice(start));
  return parts;
}

const isDynamic = (type) =>
  type === "string" || type === "bytes" || type.endsWith("[]") || (isTuple(type) && tupleParts(type).some(isDynamic));

function encodeOne(type, value) {
  if (type === "address") return { head: encodeAddress(value), tail: "" };
  if (type === "bool") return { head: word(BigInt(value ? 1 : 0)), tail: "" };
  if (type === "bytes32") return { head: encodeBytes32(value), tail: "" };
  if (isUint(type)) return { head: word(BigInt(value)), tail: "" };
  if (type === "string") return { head: null, tail: encodeString(value) };
  if (isTuple(type)) {
    if (isDynamic(type)) throw new Error(`dynamic tuples are not supported: ${type}`);
    // A static tuple is its fields laid out inline, with no offset of its own.
    const parts = tupleParts(type);
    return { head: parts.map((t, i) => encodeOne(t, value[i]).head).join(""), tail: "" };
  }
  throw new Error(`unsupported ABI type: ${type}`);
}

/// Encode a call. `signature` is the canonical form, e.g.
/// `launch(string,address,uint64,uint64,uint64)`; the selector is derived from it.
export function encodeCall(signature, args = []) {
  const types = tupleParts(signature.slice(signature.indexOf("(")));
  if (types.length !== args.length) {
    throw new Error(`${signature} takes ${types.length} args, got ${args.length}`);
  }

  const encoded = types.map((t, i) => encodeOne(t, args[i]));
  // A dynamic value's head slot holds an offset into the tail section instead.
  let tailOffset = types.length * 32;
  let head = "";
  let tail = "";
  for (const part of encoded) {
    if (part.head === null) {
      head += word(BigInt(tailOffset));
      tail += part.tail;
      tailOffset += part.tail.length / 2;
    } else {
      head += part.head;
    }
  }
  return selector(signature) + head + tail;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

const at = (hex, i) => hex.slice(i * WORD, (i + 1) * WORD);

/// Decode a return value. `types` is an array of ABI types; returns one entry each.
export function decode(types, data) {
  const hex = strip(data);
  if (hex.length === 0) return types.map(() => null);

  return types.map((type, i) => {
    if (type === "address") return `0x${at(hex, i).slice(24)}`;
    if (type === "bool") return BigInt(`0x${at(hex, i)}`) !== 0n;
    if (type === "bytes32") return `0x${at(hex, i)}`;
    if (isUint(type)) return BigInt(`0x${at(hex, i)}`);
    if (type === "string") {
      const off = Number(BigInt(`0x${at(hex, i)}`)) * 2;
      const len = Number(BigInt(`0x${hex.slice(off, off + WORD)}`));
      const body = hex.slice(off + WORD, off + WORD + len * 2);
      const bytes = new Uint8Array(len);
      for (let b = 0; b < len; b++) bytes[b] = parseInt(body.slice(b * 2, b * 2 + 2), 16);
      return new TextDecoder().decode(bytes);
    }
    if (type.endsWith("[]")) {
      const off = Number(BigInt(`0x${at(hex, i)}`)) * 2;
      const len = Number(BigInt(`0x${hex.slice(off, off + WORD)}`));
      const items = [];
      for (let n = 0; n < len; n++) {
        items.push(BigInt(`0x${hex.slice(off + WORD * (n + 1), off + WORD * (n + 2))}`));
      }
      return items;
    }
    throw new Error(`unsupported return type: ${type}`);
  });
}

/// Decode a single value — the common case for a one-word view.
export const decodeOne = (type, data) => decode([type], data)[0];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Custom errors are encoded exactly like calls, so a revert can be named by
/// matching its first four bytes against the errors a contract declares. Without
/// this the interface can only say "it reverted", which tells a user nothing about
/// which rule they broke — and every one of Keel's reverts is a rule worth naming.
export function namedError(data, signatures = []) {
  if (!data || strip(data).length < 8) return null;
  const sel = `0x${strip(data).slice(0, 8)}`;
  const body = `0x${strip(data).slice(8)}`;

  for (const signature of signatures) {
    if (selector(signature) !== sel) continue;
    const types = tupleParts(signature.slice(signature.indexOf("(")));
    const name = signature.slice(0, signature.indexOf("("));
    try {
      return { name, args: types.length ? decode(types, body) : [] };
    } catch {
      return { name, args: [] };
    }
  }

  // Solidity's own `Error(string)` — a plain `require` message.
  if (sel === selector("Error(string)")) {
    try {
      return { name: "Error", args: [decodeOne("string", body)] };
    } catch {
      return { name: "Error", args: [] };
    }
  }
  return null;
}
