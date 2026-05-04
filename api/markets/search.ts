import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  applyCors,
  badRequest,
  buildMetadata,
  canonicalCacheKey,
  cachedRead,
  getBooleanParam,
  getNumberParam,
  getStringParam,
  handleError,
  isValidCategory,
  isValidStatus,
  rejectNonGet,
} from '../lib/musashi-handler';
import { searchMarkets } from '../../src/lib/musashi-reads';

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;
const MIN_QUERY_LENGTH = 2;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  applyCors(res);
  if (rejectNonGet(req, res)) return;

  const startTime = Date.now();

  const query = getStringParam(req, 'query');
  if (!query || query.length < MIN_QUERY_LENGTH) {
    return badRequest(
      res,
      `'query' is required and must be at least ${MIN_QUERY_LENGTH} characters.`,
    );
  }

  const requestedLimit = getNumberParam(req, 'limit');
  let limit = requestedLimit ?? DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 1 || limit > MAX_LIMIT) {
    return badRequest(res, `'limit' must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  limit = Math.floor(limit);

  const categoryRaw = getStringParam(req, 'category');
  if (categoryRaw && !isValidCategory(categoryRaw)) {
    return badRequest(res, `'category' is not a valid Musashi category.`);
  }

  const statusRaw = getStringParam(req, 'status');
  if (statusRaw && !isValidStatus(statusRaw)) {
    return badRequest(res, `'status' must be one of open | closed | resolved.`);
  }

  const includeInactive = getBooleanParam(req, 'include_inactive') ?? false;

  try {
    const cacheKey = canonicalCacheKey({
      tool: 'search_markets',
      query,
      limit,
      category: categoryRaw,
      status: statusRaw,
      include_inactive: includeInactive,
    });

    const { payload, fetchedAtMs } = await cachedRead(cacheKey, () =>
      searchMarkets({
        query,
        limit,
        category: categoryRaw && isValidCategory(categoryRaw) ? categoryRaw : undefined,
        status: statusRaw && isValidStatus(statusRaw) ? statusRaw : undefined,
        includeInactive,
      }),
    );

    res.status(200).json({
      success: true,
      data: { markets: payload },
      metadata: buildMetadata(startTime, fetchedAtMs),
    });
  } catch (error) {
    handleError(res, 'Markets Search', error);
  }
}
