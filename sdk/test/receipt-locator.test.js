import test from "node:test";
import assert from "node:assert/strict";
import { chooseReceiptLocator, findReceiptLocators } from "../receipt-locator.js";

test("extracts a labeled transaction reference and a receipt URL", () => {
  const locators = findReceiptLocators(`Payment successful\nTransaction Reference: TXN-2026-000091\nReceipt URL: https://apps.cbe.com.et/receipt/abc123.`);
  assert.deepEqual(locators, [
    { type: "url", value: "https://apps.cbe.com.et/receipt/abc123" },
    { type: "reference", value: "TXN-2026-000091" }
  ]);
});

test("chooses one URL preferentially and refuses ambiguous references", () => {
  assert.deepEqual(chooseReceiptLocator([
    { type: "reference", value: "TX-111111" },
    { type: "url", value: "https://apps.cbe.com.et/receipt/one" }
  ]), { type: "url", value: "https://apps.cbe.com.et/receipt/one" });
  assert.equal(chooseReceiptLocator([
    { type: "reference", value: "TX-111111" },
    { type: "reference", value: "TX-222222" }
  ]), null);
});

test("rejects non-HTTPS URLs and does not treat ordinary amounts as references", () => {
  assert.deepEqual(findReceiptLocators("Amount: 950.00 ETB\nReceipt URL: http://example.org/receipt"), []);
  assert.deepEqual(findReceiptLocators("Reference verification\nReference: verification"), []);
});
