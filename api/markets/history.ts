import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  applyCors,
  badRequest,
  buildMetadata,
  canonicalCacheKey,
  cachedRead,
  getNumberParam,
  getStringParam,
  handleError,
  notFound,
  rejectNonGet,
} from '../lib/musashi-handler';
import { getMarketSnapshots } from '../../src/lib/musashi-reads';
import type { V1Window } from '../../src/lib/musashi-reads';

const VALID_WINDOWS: ReadonlyArray<V1Window> = ['24h', '7d', '30d', 'all'];
const DEFAULT_WINDOW: V1Window = '7d';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  applyCors(res);
  if (rejectNonGet(req, res)) return;

  const startTime = Date.now();

  const marketId = getStringParam(req, 'market_id');
  const platformId = getStringParam(req, 'platform_id');

  if ((marketId && platformId) || (!marketId && !platformId)) {
    return badRequest(
      res,
      "Provide exactly one of 'market_id' or 'platform_id'.",
    );
  }

  const windowRaw = getStringParam(req, 'window') ?? DEFAULT_WINDOW;
  if (!(VALID_WINDOWS as readonly string[]).includes(windowRaw)) {
    return badRequest(res, "'window' must be one of 24h | 7d | 30d | all.");
  }
  const window = windowRaw as V1Window;

  let limit = getNumberParam(req, 'limit') ?? DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 1 || limit > MAX_LIMIT) {
    return badRequest(res, `'limit' must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  limit = Math.floor(limit);

  try {
    const cacheKey = canonicalCacheKey({
      tool: 'get_market_history',
      market_id: marketId,
      platform_id: platformId,
      window,
      limit,
    });

    const { payload, fetchedAtMs } = await cachedRead(cacheKey, () =>
      getMarketSnapshots({ marketId, platformId, window, limit }),
    );

    if (!payload) {
      return notFound(res, 'Market not found.');
    }

    res.status(200).json({
      success: true,
      data: payload,
      metadata: buildMetadata(startTime, fetchedAtMs),
    });
  } catch (error) {
    handleError(res, 'Markets History', error);
  }
}
