// Daily Vercel cron. Flips expired 404-gift grants back to free.
// Only touches rows where grant_source='404-gift' — never clobbers Stripe subs.
// Auth: requires header `authorization: Bearer ${CRON_SECRET}` OR Vercel's own cron
// header (x-vercel-cron). Set CRON_SECRET in Vercel env for manual/CI invocations.

import { createClient } from '@supabase/supabase-js';

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    })
  : null;

export default async function handler(req, res) {
  const isVercelCron = !!req.headers['x-vercel-cron'];
  const auth = req.headers.authorization || '';
  const hasSecret = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  if (!isVercelCron && !hasSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });

  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('subscriptions')
    .update({
      plan: 'free',
      status: 'active',
      pro_until: null,
      grant_source: null,
      updated_at: nowIso,
    })
    .eq('grant_source', '404-gift')
    .lt('pro_until', nowIso)
    .is('stripe_subscription_id', null)
    .select('user_id');

  if (error) {
    console.error('[expire-freemonths]', error);
    return res.status(500).json({ error: error.message });
  }

  const expired = data?.length || 0;
  console.log('[expire-freemonths] expired', expired);
  return res.status(200).json({ ok: true, expired });
}
