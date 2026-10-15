# Deploy V-Birr to Vercel

## Included deployment setup

- `vercel.json` selects the Vite build and `dist/` output.
- `api/health.js`, `api/workspace.js`, `api/verify.js`, and `api/verify-image.js` are Vercel Functions. The last route intentionally returns `410 Gone` and never accepts screenshot uploads.
- `npm run build` bundles the Vercel frontend and packages first-party English/Amharic Tesseract OCR assets. The screenshot itself is OCR'd in the browser; only the parsed receipt URL/reference is sent to the server.
- Vercel workspace persistence uses Upstash Redis. Cloudflare Durable Objects are not used by the Vercel functions.

## Configure environment variables

In the Vercel project, add these as server-side environment variables for Preview and Production (and Development if needed):

| Variable | Purpose |
|---|---|
| `VBIRR_PROJECT_SECRET` | Long random secret used to authorize project/workspace requests. Workspace users enter it into the Connection menu for their browser session. |
| `VBIRR_RECEIPT_PROVIDER_KEY` | Links.et API key. The server also recognizes `LINKS_ET_API_KEY` as a fallback. |
| `UPSTASH_REDIS_REST_URL` | REST endpoint of the Upstash Redis database. |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token with access to the workspace database. |

Use the saved Links.et credential when setting `VBIRR_RECEIPT_PROVIDER_KEY`; do not paste it into frontend source, a `VITE_*` variable, `.env.example`, or Git. The `.env.example` file contains placeholders only.

Create an Upstash Redis database, then copy its REST URL and token into the Vercel environment settings. The app stores the workspace as a single value at `vbirr:organization-workspace:v1`; do not expose this database to browser code.

## Build and deploy

1. Connect the repository to Vercel, or import the project folder.
2. Keep the project root at the repository root. Vercel reads `vercel.json` and runs `npm run build`; the static output is `dist/`.
3. Add the environment variables above and redeploy after changing them.
4. Open `/api/health` and confirm it returns V-Birr service status. Use the app's Connection menu to enter the project secret; a successful connection should show **Server workspace connected**.
5. Run `npm test` locally before promoting changes.

For a local full-stack test, use `npx vercel dev` after configuring environment variables. `npm run dev` starts only the Vite frontend and does not emulate the Vercel API functions.

## Privacy behavior

Screenshot bytes are never posted to Vercel or Links.et. Browser OCR uses the first-party files under `/tesseract/`, runs in a temporary worker with OCR data caching disabled, and returns only extracted receipt URL/reference candidates. The server sends the selected locator to Links.et for verification. No screenshot is saved into Vercel storage, Upstash, review records, or logs.

## Implementation references

- [Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js) — supports standard Web `Request`/`Response` handlers in root `api/` functions.
- [Vercel project configuration](https://vercel.com/docs/project-configuration/vercel-json) — documents `buildCommand` and `outputDirectory` configuration.
- [Tesseract.js local installation](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md) and [API reference](https://github.com/naptha/tesseract.js/blob/master/docs/api.md) — worker/core/model path configuration and worker termination.
