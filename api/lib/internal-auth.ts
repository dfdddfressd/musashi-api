import type { VercelRequest, VercelResponse } from '@vercel/node';

export function requireAdminKey(req: VercelRequest, res: VercelResponse): boolean {
  const expected = process.env.INTERNAL_ADMIN_KEY;
  if (!expected) {
    res.status(503).json({ success: false, error: 'Internal admin auth is not configured.' });
    return false;
  }

  const provided = req.headers['x-admin-key'];
  if (typeof provided !== 'string' || provided !== expected) {
    res.status(401).json({ success: false, error: 'Unauthorized.' });
    return false;
  }

  return true;
}
