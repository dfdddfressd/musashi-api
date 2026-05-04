/**
 * Shared helpers for the four Musashi V1 read endpoints.
 *
 * Centralizes CORS, method guards, the in-memory cache wrapper, and the
 * error->HTTP-status mapping that the MCP client depends on.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getCached } from './cache-helper';
import { MusashiInfraConfigError } from '../../src/lib/musashi-infra-supabase';
import { INFRA_MARKET_CATEGORIES } from '../../src/types/musashi-infra';
import type {
  InfraMarketCategory,
  InfraMarketStatus,
} from '../../src/types/musashi-infra';

export const MUSASHI_READ_TTL_MS = 30_000;

export const VALID_STATUSES: ReadonlyArray<InfraMarketStatus> = [
  'open',
  'closed',
  'resolved',
];

export interface HandlerContext {
  req: VercelRequest;
  res: VercelResponse;
  startTime: number;
}

export function applyCors(res: VercelResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export function rejectNonGet(req: VercelRequest, res: VercelResponse): boolean {
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({
      success: false,
      error: 'Method not allowed. Use GET.',
    });
    return true;
  }
  return false;
}

export function getStringParam(req: VercelRequest, key: string): string | undefined {
  const raw = req.query[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getNumberParam(
  req: VercelRequest,
  key: string,
): number | undefined {
  const raw = getStringParam(req, key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function getBooleanParam(
  req: VercelRequest,
  key: string,
): boolean | undefined {
  const raw = getStringParam(req, key);
  if (raw === undefined) return undefined;
  const normalized = raw.toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return undefined;
}

export function isValidCategory(value: string): value is InfraMarketCategory {
  return (INFRA_MARKET_CATEGORIES as readonly string[]).includes(value);
}

export function isValidStatus(value: string): value is InfraMarketStatus {
  return (VALID_STATUSES as readonly string[]).includes(value);
}

export function badRequest(res: VercelResponse, message: string): void {
  res.status(400).json({ success: false, error: message });
}

export function notFound(res: VercelResponse, message: string): void {
  res.status(404).json({ success: false, error: message });
}

export function buildMetadata(
  startTime: number,
  cachedAt: number | null,
): { processing_time_ms: number; data_age_seconds: number; fetched_at: string } {
  const fetchedAtMs = cachedAt ?? Date.now();
  return {
    processing_time_ms: Date.now() - startTime,
    data_age_seconds: Math.round((Date.now() - fetchedAtMs) / 1000),
    fetched_at: new Date(fetchedAtMs).toISOString(),
  };
}

export function handleError(res: VercelResponse, label: string, error: unknown): void {
  console.error(`[${label}] Error:`, error);
  if (error instanceof MusashiInfraConfigError) {
    res.status(503).json({
      success: false,
      error: 'Musashi infra Supabase is not configured.',
    });
    return;
  }
  res.status(500).json({
    success: false,
    error: error instanceof Error ? error.message : 'Internal server error',
  });
}

interface CachedReadEnvelope<T> {
  fetchedAtMs: number;
  payload: T;
}

/**
 * Run a read function through the 30s in-memory cache. Only successful
 * payloads are cached; thrown errors propagate without poisoning cache.
 */
export async function cachedRead<T>(
  cacheKey: string,
  fetcher: () => Promise<T>,
): Promise<{ payload: T; fetchedAtMs: number }> {
  const envelope = await getCached<CachedReadEnvelope<T>>(
    `musashi-read:${cacheKey}`,
    async () => ({
      fetchedAtMs: Date.now(),
      payload: await fetcher(),
    }),
    MUSASHI_READ_TTL_MS,
  );
  return { payload: envelope.payload, fetchedAtMs: envelope.fetchedAtMs };
}

export function canonicalCacheKey(
  parts: Record<string, string | number | boolean | undefined>,
): string {
  const entries = Object.entries(parts)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.join('&');
}
