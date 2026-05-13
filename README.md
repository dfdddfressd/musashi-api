# musashi-api

`musashi-api` is the standalone backend repository for Musashi.

It keeps the shared prediction-market intelligence stack that used to live inside the monolithic `Musashi/` project:

- REST API handlers in [`api/`](../musashi-api/api)
- analysis pipeline in [`src/analysis/`](../musashi-api/src/analysis)
- market/Twitter clients in [`src/api/`](../musashi-api/src/api)
- SDK client in [`src/sdk/`](../musashi-api/src/sdk)
- Supabase schema and the auxiliary backend server in [`server/`](../musashi-api/server)

## Goal

This repo is the new source of truth for shared functionality. Both `musashi-extension` and `musashi-mcp` should consume this API instead of importing code from the old `Musashi/` directory.

## Scripts

- `pnpm dev`: run the local API shim on `http://127.0.0.1:3000`
- `pnpm backend:dev`: run the Supabase-backed auxiliary backend from [`server/api-server.mjs`](../musashi-api/server/api-server.mjs)
- `pnpm test`: run the offline-safe unit and integration tests with Node's built-in runner
- `pnpm test:agent`: run the API/SDK smoke and contract tests against URL `https://musashi-api.vercel.app`
- `pnpm test:agent:local`: run the same agent test suite against the local API at `http://127.0.0.1:3000`
- `pnpm typecheck`: type-check core sources, Vercel API handlers, and test files

## Environment Variables

Copy `.env.example` to `.env.local` for local development. For Vercel deployments:

| Variable | Scope | Description |
|---|---|---|
| `SUPABASE_URL` | Production, Preview | Supabase project URL (same as browser client) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Production only** | Service-role key for server-side archive writes — do **not** enable for Preview or Development |
| `SUPABASE_ARCHIVE_REQUIRED` | Production | `false` (default) — archive failures are surfaced in metadata but do not fail the cron run. Set to `true` after the first 24 h of clean runs to make archival mandatory and retry the same account batch on failure. |

## Notes

- The original reference docs were copied in `*.upstream.md` files so functionality and historical guidance remain available in this split repo.
- `vercel.json` now includes the `ground-probability` route so local and deployed API behavior stay aligned.
