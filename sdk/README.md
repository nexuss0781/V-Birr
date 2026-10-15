# V-Birr JavaScript SDK

A small, server-side JavaScript client for checking whether a receipt's sender and receiver accounts match the values your application expects.

**Verification only:** the SDK reads and checks an existing receipt. It does not initiate, submit, or authorize a payment.

## Requirements

- Node.js 18 or newer
- A V-Birr verification token stored in a server-side environment variable
- A receipt URL or supported reference, or a screenshot as base64 for local OCR
- The expected sender and fixed receiving account identifiers

Never put the token in browser code, a mobile app bundle, source control, logs, or a client-visible response. Screenshots passed to `verifyImage` are OCR'd in memory by the SDK and are not uploaded to Links.et or written to disk. Only a uniquely extracted receipt URL/reference is sent to the verification endpoint.

## Install

From this directory:

```sh
npm install
```

## Verify a receipt URL or reference

```js
import { VBirrVerificationClient } from "vbirr-verification-sdk";

const vbirr = new VBirrVerificationClient({
  token: process.env.VBIRR_VERIFICATION_TOKEN
});

const result = await vbirr.verify({
  sender: process.env.EXPECTED_SENDER_ACCOUNT,
  receiver: process.env.FIXED_RECEIVING_ACCOUNT,
  receiptUrl: process.env.RECEIPT_URL
  // Or use `reference` instead of `receiptUrl`.
});

if (result.success) {
  // true only when both account identifiers matched the verified receipt
  await fulfillOrder();
} else {
  // failed and inconclusive outcomes must go to review, never auto-fulfill
  await queueForAdminReview({ result });
}
```

## Verify a screenshot without uploading it

Pass the screenshot's raw base64 string or a `data:image/...;base64,` data URL. The SDK strips the prefix, decodes the image, reads it locally in memory, clears the temporary buffer, and terminates the OCR worker. No screenshot bytes are sent to V-Birr or Links.et. Images must be no larger than 5 MB encoded.

```js
const result = await vbirr.verifyImage({
  sender: process.env.EXPECTED_SENDER_ACCOUNT,
  receiver: process.env.FIXED_RECEIVING_ACCOUNT,
  imageBase64: screenshotBase64,
  idempotencyKey: paymentId
});

if (result.success) {
  await fulfillOrder();
} else {
  // Includes the exact parsed provider response when one was received.
  await queueForAdminReview({
    result,
    providerResponse: result.providerResponse ?? null
  });
}
```

The screenshot parser is not itself proof of payment. `success` becomes true only after Links.et verifies the extracted receipt and both account identifiers match. If no unique URL/reference is found, the result is inconclusive and includes only locator candidates for manual selection; OCR text and screenshot data are not returned.

## Result

```js
{
  success: true,
  status: "verified", // "failed" or "inconclusive" otherwise
  message: "V-Birr verified that both accounts match the receipt.",
  checks: {
    sender: "matched",
    receiver: "matched"
  }
}
```

- `success: true` only when both account identifiers are present and exactly match.
- `status: "failed"` means verification failed or at least one account mismatched.
- `status: "inconclusive"` means an account was masked, missing, or unavailable in the receipt format, or OCR did not find a unique usable URL/reference.
- If `success` is false for any reason, do not mark the payment as verified.

Account comparisons ignore punctuation and compare digits. Masked account numbers are never accepted as a match. The SDK does not retry automatically.

## Options

`new VBirrVerificationClient({ token, fetchImpl, timeoutMs })`

- `token` (required): server-side verification credential.
- `fetchImpl` (optional): Fetch-compatible function, useful for testing.
- `timeoutMs` (optional): request timeout; defaults to 130,000 ms.

`verify({ sender, receiver, receiptUrl, reference, idempotencyKey, signal })`

- `sender`, `receiver` (required): expected account identifiers.
- `receiptUrl` or `reference` (required): provide exactly one.
- `idempotencyKey` (optional): safe retry key supplied by your application.
- `signal` (optional): `AbortSignal` for caller-controlled cancellation.

`verifyImage({ sender, receiver, imageBase64, idempotencyKey, signal })`

- `sender`, `receiver` (required): expected account identifiers.
- `imageBase64` (required): a screenshot's raw base64 string or image data URL, no larger than 5 MB encoded. OCR is local; only an extracted locator may be sent to Links.et.
- `idempotencyKey` (optional): safe retry key supplied by your application.
- `signal` (optional): `AbortSignal` for caller-controlled cancellation.
- For ambiguous OCR, `referenceCandidates` contains extracted URLs/references for manual review; raw OCR text and image data are not returned.

## Test

```sh
npm test
```
