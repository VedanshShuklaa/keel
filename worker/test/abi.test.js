import test from "node:test";
import assert from "node:assert/strict";

import { encodeCall, decode, decodeOne, namedError } from "../../web/lib/abi.js";

// Reference calldata produced by `cast calldata`. The console builds every
// transaction by hand — no bundler, no library — so the encoder is checked against
// the real thing rather than against itself. A malformed argument would still send
// a valid transaction that does the wrong thing, which is why this is pinned.

test("encodes a call with a dynamic string argument", () => {
  assert.equal(
    encodeCall("launch(string,address,uint64,uint64,uint64)", [
      "SOL",
      "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
      8n,
      300n,
      300n,
    ]),
    "0xaee0e8fe" +
      "00000000000000000000000000000000000000000000000000000000000000a0" +
      "00000000000000000000000070a86d8842fb63c4ad2b7cdddf530ebf1bb25d8e" +
      "0000000000000000000000000000000000000000000000000000000000000008" +
      "000000000000000000000000000000000000000000000000000000000000012c" +
      "000000000000000000000000000000000000000000000000000000000000012c" +
      "0000000000000000000000000000000000000000000000000000000000000003" +
      "534f4c0000000000000000000000000000000000000000000000000000000000",
  );
});

test("a string that fills a whole word still pads correctly", () => {
  assert.equal(
    encodeCall("launch(string,address,uint64,uint64,uint64)", [
      "FARTCOIN",
      "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
      8n,
      3600n,
      300n,
    ]),
    "0xaee0e8fe00000000000000000000000000000000000000000000000000000000000000a0" +
      "00000000000000000000000070a86d8842fb63c4ad2b7cdddf530ebf1bb25d8e" +
      "0000000000000000000000000000000000000000000000000000000000000008" +
      "0000000000000000000000000000000000000000000000000000000000000e10" +
      "000000000000000000000000000000000000000000000000000000000000012c" +
      "0000000000000000000000000000000000000000000000000000000000000008" +
      "46415254434f494e000000000000000000000000000000000000000000000000",
  );
});

test("encodes a static tuple inline, with no offset of its own", () => {
  assert.equal(
    encodeCall("bootstrap(address,uint256,uint256,address,(uint256,uint256,uint256))", [
      "0x0cdF60D07589f9b989dbD4c5F1D1F961Bb7c572d",
      0n,
      0n,
      "0x0000000000000000000000000000000000000000",
      [1000n, 1000n, 1000n],
    ]),
    "0x1f460005" +
      "0000000000000000000000000cdf60d07589f9b989dbd4c5f1d1f961bb7c572d" +
      "0000000000000000000000000000000000000000000000000000000000000000" +
      "0000000000000000000000000000000000000000000000000000000000000000" +
      "0000000000000000000000000000000000000000000000000000000000000000" +
      "00000000000000000000000000000000000000000000000000000000000003e8" +
      "00000000000000000000000000000000000000000000000000000000000003e8" +
      "00000000000000000000000000000000000000000000000000000000000003e8",
  );
});

test("encodes addresses, WAD prices and raw token amounts", () => {
  assert.equal(
    encodeCall("quote(address,uint256,uint256)", [
      "0xa02E260B7A49595248bC1eB2BcCc1C87E6964180",
      500000000000000000n,
      25000000n,
    ]),
    "0x9e8cc04b000000000000000000000000a02e260b7a49595248bc1eb2bccc1c87e696418000000000000000000000000000000000000000000000000006f05b59d3b2000000000000000000000000000000000000000000000000000000000000017d7840",
  );
});

test("encodes bytes32 market ids", () => {
  assert.equal(
    encodeCall("registerPool(address,bytes32)", [
      "0xa02E260B7A49595248bC1eB2BcCc1C87E6964180",
      "0x0000000000000000000000000000000000000000000000000000000000010eac",
    ]),
    "0xd852c8b6" +
      "000000000000000000000000a02e260b7a49595248bc1eb2bccc1c87e6964180" +
      "0000000000000000000000000000000000000000000000000000000000010eac",
  );
});

test("refuses arguments it cannot encode rather than sending something wrong", () => {
  assert.throws(() => encodeCall("f(address)", ["not-an-address"]), /not an address/);
  assert.throws(() => encodeCall("f(address,uint256)", ["0x" + "11".repeat(20)]), /takes 2 args, got 1/);
  assert.throws(() => encodeCall("f(bytes)", ["0x00"]), /unsupported ABI type/);
});

test("decodes the shapes the console reads back", () => {
  const w = (h) => h.padStart(64, "0");
  assert.equal(decodeOne("uint256", `0x${w("3e8")}`), 1000n);
  assert.equal(decodeOne("bool", `0x${w("1")}`), true);
  assert.equal(decodeOne("bool", `0x${w("0")}`), false);
  assert.equal(decodeOne("address", `0x${w("a02e260b7a49595248bc1eb2bccc1c87e6964180")}`).toLowerCase(),
    "0xa02e260b7a49595248bc1eb2bccc1c87e6964180");

  // openOrders(address) returns uint128[] — an offset, a length, then the ids.
  const arr = `0x${w("20")}${w("2")}${w("1")}${w("2")}`;
  assert.deepEqual(decodeOne("uint128[]", arr), [1n, 2n]);

  // An empty return decodes to nulls rather than throwing, so a view on a
  // contract that is not there reads as "unknown" instead of crashing a panel.
  assert.deepEqual(decode(["uint256", "bool"], "0x"), [null, null]);
});

test("names a custom error so a revert says which rule was broken", () => {
  // InsufficientLaunchValue(uint256) carrying 18 STT.
  const data = encodeCall("InsufficientLaunchValue(uint256)", [18000000000000000000n]);
  const named = namedError(data, ["InsufficientLaunchValue(uint256)", "AlreadyLaunched(uint32)"]);
  assert.equal(named.name, "InsufficientLaunchValue");
  assert.equal(named.args[0], 18000000000000000000n);

  // A selector we do not know is reported as unknown, not guessed at.
  assert.equal(namedError("0xdeadbeef", ["AlreadyLaunched(uint32)"]), null);
  assert.equal(namedError("0x", ["AlreadyLaunched(uint32)"]), null);
});

test("decodes a plain require message", () => {
  const data = encodeCall("Error(string)", ["not creator owner"]);
  assert.deepEqual(namedError(data, []), { name: "Error", args: ["not creator owner"] });
});
