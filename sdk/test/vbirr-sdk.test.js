import test from "node:test";
import assert from "node:assert/strict";
import { VBirrVerificationClient } from "../index.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function clientWith(body, status = 200, capture = {}) {
  return new VBirrVerificationClient({
    token: "test-token-do-not-return",
    fetchImpl: async (url, options) => {
      capture.url = url;
      capture.options = options;
      return jsonResponse(body, status);
    }
  });
}

const matchedReceipt = {
  ok: true,
  receipt: {
    source: "cbe-pdf",
    payerAccount: "251-911-222-333",
    receiverAccount: "100-200-300-400",
    transferredAmount: 25,
    reference: "private-reference"
  }
};

const expected = {
  sender: "+251 911 222 333",
  receiver: "100 200 300 400",
  receiptUrl: "https://receipts.example/receipt/private"
};

test("returns a clear verified result when both accounts match", async () => {
  const capture = {};
  const result = await clientWith(matchedReceipt, 200, capture).verify(expected);

  assert.equal(result.success, true);
  assert.equal(result.status, "verified");
  assert.deepEqual(result.checks, { sender: "matched", receiver: "matched" });
  assert.match(result.message, /V-Birr/);
  assert.equal(capture.options.method, "POST");
  assert.equal(capture.options.headers["x-api-key"], "test-token-do-not-return");
  assert.deepEqual(JSON.parse(capture.options.body), { url: expected.receiptUrl });
  assert.equal(JSON.stringify(result).includes("test-token-do-not-return"), false);
  assert.equal(JSON.stringify(result).includes("private-reference"), false);
});

test("returns failure when either account mismatches", async () => {
  const body = structuredClone(matchedReceipt);
  body.receipt.receiverAccount = "999-888-777-666";
  const result = await clientWith(body).verify(expected);

  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.checks, { sender: "matched", receiver: "mismatch" });
});

test("does not accept masked account numbers as matches", async () => {
  const body = structuredClone(matchedReceipt);
  body.receipt.payerAccount = "251-***-222-333";
  const result = await clientWith(body).verify(expected);

  assert.equal(result.success, false);
  assert.equal(result.status, "inconclusive");
  assert.equal(result.checks.sender, "inconclusive");
});

test("returns inconclusive for unsupported receipt formats", async () => {
  const result = await clientWith({
    ok: true,
    receipt: { source: "unmapped-format", payerName: "Example", receiverName: "Example" }
  }).verify(expected);

  assert.equal(result.success, false);
  assert.equal(result.status, "inconclusive");
  assert.deepEqual(result.checks, { sender: "unavailable", receiver: "unavailable" });
});

test("does not echo raw upstream errors or receipt data", async () => {
  const result = await clientWith({
    ok: false,
    error: { code: "invalid_request", message: "contains private receipt URL" }
  }, 400).verify(expected);

  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "INVALID_REQUEST");
  assert.equal(JSON.stringify(result).includes("private receipt URL"), false);
  assert.equal(JSON.stringify(result).includes(expected.receiptUrl), false);
});

test("validates party accounts and requires exactly one receipt locator without making a request", async () => {
  let calls = 0;
  const client = new VBirrVerificationClient({
    token: "test-token",
    fetchImpl: async () => { calls += 1; return jsonResponse(matchedReceipt); }
  });

  const invalidAccounts = await client.verify({ ...expected, sender: "***" });
  const bothLocators = await client.verify({ ...expected, reference: "ref-123" });
  const noLocator = await client.verify({ sender: expected.sender, receiver: expected.receiver });

  assert.equal(invalidAccounts.success, false);
  assert.equal(bothLocators.error.code, "INVALID_RECEIPT_INPUT");
  assert.equal(noLocator.error.code, "INVALID_RECEIPT_INPUT");
  assert.equal(calls, 0);
});

test("supports a reference and optional idempotency key", async () => {
  const capture = {};
  const result = await clientWith(matchedReceipt, 200, capture).verify({
    sender: expected.sender,
    receiver: expected.receiver,
    reference: "REF-123",
    idempotencyKey: "retry-safe-1"
  });

  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(capture.options.body), { reference: "REF-123" });
  assert.equal(capture.options.headers["Idempotency-Key"], "retry-safe-1");
});

test("OCRs a screenshot locally then sends only its receipt reference to Links.et", async () => {
  const capture = {};
  let temporaryBuffer;
  const client = new VBirrVerificationClient({
    token: "test-token-do-not-return",
    ocrImpl: async (imageBytes) => {
      temporaryBuffer = imageBytes;
      assert.equal(imageBytes.toString(), "hello");
      return [{ type: "reference", value: "TX-12345" }];
    },
    fetchImpl: async (url, options) => {
      capture.url = url;
      capture.options = options;
      return jsonResponse(matchedReceipt);
    }
  });
  const result = await client.verifyImage({
    sender: expected.sender,
    receiver: expected.receiver,
    imageBase64: "data:image/png;base64,aGVsbG8=",
    idempotencyKey: "review-123"
  });

  assert.equal(capture.url, "https://links.et/api/verify");
  assert.deepEqual(JSON.parse(capture.options.body), { reference: "TX-12345" });
  assert.equal(capture.options.headers["Idempotency-Key"], "review-123");
  assert.equal(result.status, "verified");
  assert.equal(result.parsedFromScreenshot, true);
  assert.deepEqual(result.checks, { sender: "matched", receiver: "matched" });
  assert.ok(temporaryBuffer.every((byte) => byte === 0));
  assert.equal(JSON.stringify(capture.options.body).includes("hello"), false);
  assert.equal(JSON.stringify(result).includes("test-token-do-not-return"), false);
});

test("ambiguous or missing screenshot locators remain inconclusive without a provider request", async () => {
  let calls = 0;
  const client = new VBirrVerificationClient({
    token: "test-token",
    ocrImpl: async () => [
      { type: "reference", value: "TX-12345" },
      { type: "reference", value: "TX-67890" }
    ],
    fetchImpl: async () => { calls += 1; return jsonResponse(matchedReceipt); }
  });
  const result = await client.verifyImage({ sender: expected.sender, receiver: expected.receiver, imageBase64: "aGVsbG8=" });
  assert.equal(result.status, "inconclusive");
  assert.equal(result.error.code, "AMBIGUOUS_RECEIPT_LOCATOR");
  assert.equal(result.referenceCandidates.length, 2);
  assert.equal(calls, 0);
});

test("rejects oversized or invalid screenshot base64 before OCR or provider requests", async () => {
  let calls = 0;
  const client = new VBirrVerificationClient({
    token: "test-token",
    ocrImpl: async () => { calls += 1; return []; },
    fetchImpl: async () => { calls += 1; return jsonResponse({ ok: true }); }
  });
  const invalid = await client.verifyImage({ sender: expected.sender, receiver: expected.receiver, imageBase64: "not base64?" });
  const oversized = await client.verifyImage({
    sender: expected.sender,
    receiver: expected.receiver,
    imageBase64: "A".repeat(5 * 1024 * 1024 + 1)
  });

  assert.equal(invalid.error.code, "INVALID_IMAGE");
  assert.equal(oversized.error.code, "INVALID_IMAGE");
  assert.equal(calls, 0);
});

test("returns a safe network failure instead of leaking exception details", async () => {
  const client = new VBirrVerificationClient({
    token: "test-token",
    fetchImpl: async () => { throw new Error("private host and token details"); }
  });
  const result = await client.verify(expected);

  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "NETWORK_ERROR");
  assert.equal(JSON.stringify(result).includes("private host"), false);
});
