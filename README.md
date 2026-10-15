# V-Birr

V-Birr is an organization payment-verification workspace. It checks an existing payment receipt against the project's fixed receiving account and the sender's registered payer account; it does not initiate transfers or replace admin review.

## Screenshot privacy

Receipt screenshots are read locally in the browser with English and Amharic OCR. The screenshot is not uploaded to V-Birr or Links.et and is not written into workspace storage, review records, or logs. The temporary OCR worker is terminated after parsing, and the app clears the file input and in-app file references. Only the chosen receipt URL/reference and account details are sent to the Vercel API for an on-the-fly Links.et lookup. The old `/api/verify-image` route returns `410 Gone` and never forwards images.

## Local development

```sh
npm install
npm run dev
npm test
npm run build
```

`npm run dev` serves the Vite frontend only. The API routes require the Vercel runtime; use `npx vercel dev` with environment variables for a full-stack local test. `npm run build` creates the Vercel static output in `dist/` and syncs `public/` for the optional Cloudflare Worker deployment.

## Deployment

Vercel requires server-side environment variables for `VBIRR_PROJECT_SECRET`, `VBIRR_RECEIPT_PROVIDER_KEY`, `UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN`. Never expose these as `VITE_*` variables or commit real values. `.env.example` contains placeholders only. The Vercel API stores project and review state in Upstash Redis; screenshot data is never stored there.

See [VERCEL_DEPLOYMENT.md](./VERCEL_DEPLOYMENT.md) for setup steps, [INTEGRATION_NOTES.md](./INTEGRATION_NOTES.md) for API and privacy details, and [sdk/README.md](./sdk/README.md) for the Node.js SDK.
