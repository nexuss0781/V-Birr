# V-Birr JavaScript SDK

A server-side JavaScript SDK for creating organization projects, registering payer accounts, and validating receipt transactions against account details.

**Verification only:** the SDK checks existing receipts. It does not initiate, submit, or authorize payments. Keep all V-Birr credentials on a trusted server; never use either client in browser code or a mobile app bundle.

## Requirements

- Node.js 18 or newer
- A V-Birr API base URL
- A V-Birr project secret stored in a server-side environment variable

## Install

From this directory:

```sh
npm install
```

## Create a project and register a payer

```js
import { VBirrClient } from "v-birr";

const vbirr = new VBirrClient({
  baseUrl: process.env.VBIRR_API_BASE_URL,
  projectSecret: process.env.VBIRR_PROJECT_SECRET
});

const project = await vbirr.createProject({
  organization: "Example Trading PLC",
  name: "Monthly collections",
  accountType: "CBE",
  baseAccount: "0987652314"
});

await vbirr.addPayer({
  projectId: project.id,
  name: "Payer One",
  accountNumber: "0912792308"
});
```

Project creation saves the fixed receiving `baseAccount` in V-Birr's authenticated server workspace. `addPayer` registers a full sender account for that project. These are SDK operations and do not require the frontend.

## Generic transaction verification

For a one-off or generic integration, supply both account numbers and exactly one receipt URL, reference, or transaction number. `transactionNumber` is an alias for `reference`.

```js
const result = await vbirr.verify({
  baseAccount: "0987652314",
  clientAccount: "0912792308",
  transactionNumber: "TX-001234"
});

if (result.success) {
  // Both receipt accounts matched.
  console.log(result.receipt, result.accountChecks, result.fetchedAt);
} else {
  // Do not treat mismatches, inconclusive results, or review states as verified.
  await queueForAdminReview({ result });
}
```

## Project-bound transaction verification

After creating a project, validate a user's full account number and transaction number against the project's fixed receiving account and payer directory:

```js
const result = await vbirr.verifyProject({
  projectId: project.id,
  clientAccount: "0912792308",
  transactionNumber: "TX-001234"
});

if (result.success) {
  // Receipt accounts match and the payer is registered to this project.
} else if (result.status === "needs_review") {
  // The sender is not registered; require manual review instead of auto-approval.
  await queueForAdminReview({ result });
}
```

The receiving account is loaded from the server-side project and cannot be replaced in a project-bound check. The result includes the receipt summary, account checks, decision, project registration status, fetch time, and the provider response returned by the authenticated V-Birr API. These fields may contain sensitive transaction information; store and log them accordingly.

## Result shape

```js
{
  success: true,
  status: "matched", // also "needs_review", "mismatch", "inconclusive", or "failed"
  receipt: { source: "cbe-pdf", amount: 50, currency: "ETB" },
  accountChecks: {
    sender: { status: "matched", field: "payerAccount" },
    recipient: { status: "matched", field: "receiverAccount" }
  },
  decision: { status: "matched", grant: true },
  project: null,
  fetchedAt: "2026-10-15T00:00:00Z",
  providerResponse: { /* receipt details returned by V-Birr */ },
  error: null
}
```

`success` is true only when V-Birr's decision explicitly grants validation. An unregistered project payer can return `needs_review` even if the receipt's account numbers match. Masked, missing, or unavailable account numbers are never treated as matches.

## SDK methods and options

```js
new VBirrClient({ baseUrl, projectSecret, fetchImpl, timeoutMs, idFactory })
```

- `baseUrl` (required): V-Birr API deployment URL. HTTPS is required; HTTP is allowed only for localhost development.
- `projectSecret` (required): server-side V-Birr project/admin secret.
- `fetchImpl` (optional): Fetch-compatible function, useful for tests.
- `timeoutMs` (optional): request timeout; defaults to 30 seconds.
- `idFactory` (optional): project/payer ID factory; defaults to `crypto.randomUUID`.

Methods:

- `createProject({ organization, name, accountType, baseAccount, id, createdAt, signal })`
- `addPayer({ projectId, name, accountNumber, id, createdAt, signal })`
- `getWorkspace({ signal })`
- `verify({ baseAccount, clientAccount, receiptUrl, reference, transactionNumber, idempotencyKey, signal })`
- `verifyProject({ projectId, clientAccount, receiptUrl, reference, transactionNumber, idempotencyKey, signal })`

The project and payer methods update the existing workspace using a read-modify-write request. Coordinate simultaneous workspace mutations across separate processes to avoid overwriting updates.

## Direct verification and local screenshot OCR

The legacy `VBirrVerificationClient` is also exported for direct receipt checks and local screenshot OCR:

```js
import { VBirrVerificationClient } from "v-birr";

const directClient = new VBirrVerificationClient({
  token: process.env.VBIRR_VERIFICATION_TOKEN
});

const result = await directClient.verify({
  sender: "0912792308",
  receiver: "0987652314",
  reference: "TX-001234"
});
```

`verifyImage({ sender, receiver, imageBase64, idempotencyKey, signal })` reads a screenshot locally in memory. The screenshot is not uploaded or written to disk. The image must be no larger than 5 MB encoded; OCR must find one unique receipt URL/reference before verification proceeds. Ambiguous candidates are returned for manual selection; raw OCR text and image data are not returned.

## Tests

```sh
npm test
```
