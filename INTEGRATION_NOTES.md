# V-Birr receipt verification integration

V-Birr verifies an existing receipt and compares its sender and receiver with the expected values. It does not initiate or authorize a transfer. The Links.et verification credential stays in server-side environment variables and is never exposed to browser code.

## Screenshot privacy

- Screenshots are OCR'd in the user's browser using first-party Vercel static assets (English and Amharic). The OCR worker runs only for the current request and is terminated afterward; OCR model caching is disabled.
- V-Birr does not upload, persist, or put screenshot bytes in its API requests, workspace, review records, logs, or build output. After OCR, the web app clears the file input and releases its in-app file references.
- Only one parsed receipt URL/reference plus the entered sender account and project ID is sent to V-Birr. V-Birr then makes an on-the-fly request to Links.et's `/api/verify` endpoint. The legacy `/api/verify-image` route now returns HTTP 410 and never forwards image data.
- If OCR cannot identify a unique locator, the user can select among candidates or enter the URL/reference manually. Raw OCR text is not displayed or saved.

## Vercel deployment

- `vercel.json` configures the Vite static build (`npm run build`, output `dist/`). Vercel discovers the four functions in `api/` automatically.
- `/api/verify` and `/api/health` reuse the Worker logic through `lib/vercel-handler.js`; `/api/workspace` uses Upstash Redis as the Vercel-compatible durable store.
- Configure these Vercel environment variables before production use:
  - `VBIRR_PROJECT_SECRET`: a long random project/admin secret supplied by authorized workspace users in the browser session.
  - `VBIRR_RECEIPT_PROVIDER_KEY`: the Links.et API key. `LINKS_ET_API_KEY` is accepted as a fallback name.
  - `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: Upstash Redis REST connection values for project/review storage.
- Never put deployment secrets in `VITE_*` variables or source files. See `VERCEL_DEPLOYMENT.md` for setup instructions.

## Workspace and API

- `GET /api/workspace` and `PUT /api/workspace` load and save organization projects, payer accounts, activity, and admin review records. Both require `x-vbirr-project-secret` and a configured server-side store.
- Vercel stores the workspace as one JSON value in Upstash under `vbirr:organization-workspace:v1`. Cloudflare deployments continue to use the `VBIRR_WORKSPACE` Durable Object binding declared in `wrangler.jsonc`.
- Workspace writes are limited to 4 MiB and reject screenshot payloads. Screenshot verification is not part of the workspace schema.
- `POST /api/verify` accepts exactly one supported receipt URL or reference, plus `clientAccount` and either a trusted `projectId` or the legacy direct `baseAccount` integration fields.
- For project-bound checks, V-Birr loads the fixed receiving account and payer directory from authenticated server workspace. It does not trust a caller-supplied replacement receiving account. An account match for an unregistered payer is `needs_review`, never an automatic grant.
- Automatic approval requires a source-verified receipt with exact, unmasked sender and receiver matches. A masked or unavailable account is inconclusive; a mismatch fails.
- Verification responses preserve the original Links.et response for authorized admin review. Do not log receipt URLs, references, account identifiers, credentials, or raw provider responses.

## Vercel build

Run `npm install` and `npm run build`. The build bundles the Vite frontend, copies the OCR worker/WASM and English/Amharic trained data into `dist/tesseract/`, then synchronizes `public/` for the optional Cloudflare Worker deployment. Screenshots are never part of the build assets.
