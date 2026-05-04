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
- `pnpm test:agent`: run the API/SDK smoke and contract tests against URL `https://musashi-api.vercel.app`
- `pnpm test:agent:local`: run the same agent test suite against the local API at `http://127.0.0.1:3000`
- `pnpm test:musashi-reads`: run unit + in-process handler tests for the V1 Musashi read endpoints
- `pnpm typecheck`: type-check core sources plus Vercel API handlers

## Musashi V1 read endpoints

These four endpoints back the V1 MCP tools in `musashi-mcp` (`search_markets`, `get_market`, `get_market_history`, `get_market_resolution_context`). They read from the `musashi-infra` Supabase project (tables `markets`, `market_snapshots`, `market_resolutions`, `markets_archive`) and are scoped to `platform = 'kalshi'`.

Required environment:

- `MUSASHI_INFRA_SUPABASE_URL`
- `MUSASHI_INFRA_SUPABASE_SERVICE_KEY`

If either is missing, the endpoints return `503` until configured.

All four return `{ success: true, data, metadata: { processing_time_ms, data_age_seconds, fetched_at } }` on success and `{ success: false, error }` on failure. HTTP status maps to the MCP error taxonomy: `400 → invalid_input`, `404 → not_found`, `5xx → upstream_unavailable`. Each response is cached in-process for 30 seconds, keyed by query params.

### `GET /api/markets/search`

Query: `query` (required, ≥2 chars), `limit` (default 10, max 25), `category`, `status` (`open`/`closed`/`resolved`), `include_inactive` (default `false`). Excludes `source_missing_at != null` and `is_active = false` rows unless `include_inactive=true`.

### `GET /api/markets/lookup`

Query: exactly one of `market_id` or `platform_id`. Returns the full canonical market state including `settles_at` and `source_missing_at`. Falls back to `markets_archive` when the row is no longer in the hot `markets` table.

### `GET /api/markets/history`

Query: exactly one of `market_id` or `platform_id`; `window` ∈ `24h | 7d | 30d | all` (default `7d`); `limit` (default 200, max 1000). Returns market identity + ordered snapshot points. Empty `snapshots` array is a valid `200`.

### `GET /api/markets/resolution-context`

Query: exactly one of `market_id` or `platform_id`. Returns market identity, the market's own resolution state, a category-level resolved count, and a similar-group resolved count (using `event_id` then `series_id`). Returns `similar_market_resolution_count: null` with a `notes` string when neither group is available — never fabricates.

## Notes

- The original reference docs were copied in `*.upstream.md` files so functionality and historical guidance remain available in this split repo.
- `vercel.json` now includes the `ground-probability` route so local and deployed API behavior stay aligned.
