import type { VercelResponse } from '@vercel/node';

const DISABLED_MESSAGE =
  'KV-backed feature temporarily disabled to prevent runaway Upstash costs.';

export function kvFeaturesEnabled(): boolean {
  return process.env.MUSASHI_ENABLE_KV_FEATURES === 'true';
}

export function sendKvFeatureDisabled(
  res: VercelResponse,
  feature: string,
): void {
  res.status(503).json({
    success: false,
    error: `${feature} is temporarily disabled.`,
    note: DISABLED_MESSAGE,
  });
}
