---
name: v-birr-sdk
description: Use the V-Birr JavaScript SDK from trusted Node.js server-side applications to create projects, register payer accounts, verify transactions, inspect receipt details, and route uncertain or unregistered results for manual review.
---

# V-Birr JavaScript SDK

Use this skill for integrations with the `v-birr` JavaScript package. Keep work within the SDK unless the user explicitly asks for a separate frontend change. The SDK verifies existing receipts; it does not initiate, submit, or authorize payments.

## Set up safely

- Use Node.js 18 or newer and import `VBirrClient` from `v-birr`.
- Construct the client only in trusted server-side code. Read `baseUrl` and `projectSecret` from server environment variables; never place credentials in browser bundles, mobile apps, source control, logs, or user-visible output.
- Require HTTPS for deployed API URLs. HTTP is allowed only for localhost development.
- Ask for missing configuration through the approved secure input flow; do not invent credentials or expose a secret in examples.

```js
import { VBirrClient } from "v-birr";

const vbirr = new VBirrClient({
  baseUrl: process.env.VBIRR_API_BASE_URL,
  projectSecret: process.env.VBIRR_PROJECT_SECRET
});
```

## Choose the verification workflow

### Generic transaction lookup

Use `verify` when the caller supplies both accounts and there is no saved project:

```js
const result = await vbirr.verify({
  baseAccount,       // receiving account
  clientAccount,     // sender/payer account
  transactionNumber  // or use exactly one of receiptUrl or reference
});
```

Provide exactly one of `receiptUrl`, `reference`, or `transactionNumber`; `transactionNumber` is an alias for `reference`. Receipt URLs must be HTTPS. Account values must be full, unmasked account numbers. The result can include receipt details, account checks, fetch time, a decision, and an error code. Treat transaction and account data as sensitive.

### Project setup and payer registration

Use `createProject` to save a project's fixed receiving account, then `addPayer` to register each authorized sender account:

```js
const project = await vbirr.createProject({
  organization,
  name,
  accountType,
  baseAccount
});

const payer = await vbirr.addPayer({
  projectId: project.id,
  name: payerName,
  accountNumber
});
```

Use full, unmasked account numbers only when the user has authorized their registration. `getWorkspace()` reads the projects, payer records, review queue, and activity. The SDK has no payer update/delete method: do not pretend to change a registration or replace a project's receiving account through `verifyProject`. Coordinate workspace mutations because project and payer writes use a read-modify-write flow and concurrent writes can overwrite each other.

### Project-bound verification

Use `verifyProject` when a project already exists. It checks the supplied client account and transaction locator against the project's stored fixed receiving account and registered payer list; do not pass or infer a replacement receiving account.

```js
const result = await vbirr.verifyProject({
  projectId,
  clientAccount,
  reference // or exactly one of receiptUrl or transactionNumber
});
```

An unregistered payer can produce `needs_review` even when the receipt's account details match. Do not automatically register an unrecognized payer as a side effect of checking a receipt.

## Apply a fail-closed decision rule

Automatically treat a check as verified only when all of these are true:

```js
result.success === true &&
result.status === "matched" &&
result.decision?.grant === true
```

Route every other result to the application's manual review path, including `needs_review`, `mismatch`, `inconclusive`, and `failed`. In particular, never grant access or fulfill an order based only on a receipt being found, a matching amount, a payer name, or a partial/masked account number. Preserve enough context for an authorized reviewer, while minimizing stored receipt data and redacting secrets and unnecessary account details from logs.

Verification methods return a result object on request/verification failures; project and payer workspace methods can throw. Catch errors without logging credentials or raw sensitive responses. Use an `idempotencyKey` for verification retries when the same logical check is being retried, and honor cancellation through `signal` when appropriate.

## Keep the scope clear

- The SDK is for receipt verification and project/payer workspace operations, not payment execution.
- Prefer `VBirrClient` for project-based and generic transaction verification. Do not substitute the legacy direct-verification client unless maintaining an integration that explicitly uses it.
- Do not expose full receipt responses or account numbers in client-visible messages. Return a minimal status and route exceptions or ambiguous results to manual review.
- If an operation is unsupported by the SDK, inspect the installed package's `sdk/README.md` and source before proposing another endpoint or modifying the frontend.
