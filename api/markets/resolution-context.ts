import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  applyCors,
  badRequest,
  buildMetadata,
  canonicalCacheKey,
  cachedRead,
  getStringParam,
  handleError,
  notFound,
  rejectNonGet,
} from '../lib/musashi-handler';
import { getMarketResolutionContext } from '../../src/lib/musashi-reads';

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

  try {
    const cacheKey = canonicalCacheKey({
      tool: 'get_market_resolution_context',
      market_id: marketId,
      platform_id: platformId,
    });

    const { payload, fetchedAtMs } = await cachedRead(cacheKey, () =>
      getMarketResolutionContext({ marketId, platformId }),
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
    handleError(res, 'Markets Resolution Context', error);
  }
}
