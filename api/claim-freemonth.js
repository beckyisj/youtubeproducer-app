// /api/claim-freemonth — handles 404-gift submissions.
// 1. Validates input.
// 2. Finds or creates the Supabase auth user for the email.
// 3. Upserts the subscriptions row:
//    - Skips paid Stripe subs (never clobbers real subscribers).
//    - Extends pro_until if already on a free-gift grant.
//    - Otherwise flips plan='pro' for 30 days (60 if source_detail given = bonus).
// 4. Sends a magic sign-in link via Supabase + Resend.
// 5. Notifies Becky (optional, via Resend).
// 6. Logs a row in freemonth_claims.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
// Optional env vars:
//   RESEND_API_KEY           — sends magic link + owner notification. Without it, users
//                              will only be granted pro but won't get an email.
//   CLAIM_NOTIFY_EMAIL       — owner notification target (default beckyisjwara@gmail.com).
//   CLAIM_FROM_EMAIL         — sender (default: "YouTube Producer <becky@youtubeproducer.app>").
//                              Domain must be verified in Resend.
//   CLAIM_REDIRECT_URL       — where the magic link lands (default https://audit.youtubeproducer.app).

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_TO = process.env.CLAIM_NOTIFY_EMAIL || 'beckyisjwara@gmail.com';
const FROM = process.env.CLAIM_FROM_EMAIL || 'YouTube Producer <hello@youtubeproducer.app>';
const REDIRECT = process.env.CLAIM_REDIRECT_URL || 'https://audit.youtubeproducer.app';

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const name = str(body.name, 200);
  const email = str(body.email, 200).toLowerCase();
  const use_case = str(body.use_case, 2000);
  const source = str(body.source, 200);
  const source_detail = str(body.source_detail, 2000);
  const path = str(body.path, 500);
  const referrer = str(body.referrer, 500);
  const userAgent = str(body.userAgent, 500);

  if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !use_case || !source) {
    return res.status(400).json({ error: 'Missing or invalid fields' });
  }

  const months = source_detail ? 2 : 1; // bonus: 2 months if they share the AI prompt
  const nowMs = Date.now();
  const record = {
    ts: new Date(nowMs).toISOString(),
    name, email, use_case, source, source_detail, path, referrer, userAgent,
    months,
  };
  console.log('[claim-freemonth]', JSON.stringify(record));

  if (!supabase) {
    // Supabase not configured — still accept the claim so the UI doesn't fail,
    // and surface it in logs for manual handling.
    await notifyOwner({ ...record, note: 'Supabase not configured — grant manually.' });
    return res.status(200).json({ ok: true, granted: false });
  }

  try {
    const userId = await findOrCreateUser(email);
    const grant = await grantFreeMonth(userId, months);
    await supabase.from('freemonth_claims').insert({
      user_id: userId, email, name, use_case, source, source_detail,
      path, referrer, user_agent: userAgent, months_granted: months,
    });
    const magicLink = await generateMagicLink(email);
    await Promise.all([
      sendUserEmail({ email, name, months, magicLink, grant }),
      notifyOwner({ ...record, userId, grant }),
    ]);
    return res.status(200).json({ ok: true, granted: grant.granted });
  } catch (e) {
    console.error('[claim-freemonth] error', e);
    await notifyOwner({ ...record, error: String(e?.message || e) }).catch(() => {});
    // Still return 200 — the user filled the form, it's not their problem to retry.
    return res.status(200).json({ ok: true, granted: false });
  }
}

function str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

async function findOrCreateUser(email) {
  // Try to create. If already exists, list and find.
  const { data, error } = await supabase.auth.admin.createUser({
    email, email_confirm: true,
  });
  if (!error && data?.user) return data.user.id;

  // Paginate to find. In practice, small user base — 1-2 pages.
  for (let page = 1; page <= 20; page++) {
    const { data: list, error: listErr } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (listErr) throw listErr;
    const hit = list?.users?.find((u) => (u.email || '').toLowerCase() === email);
    if (hit) return hit.id;
    if (!list?.users?.length || list.users.length < 200) break;
  }
  throw new Error(`Could not find or create user for ${email}: ${error?.message}`);
}

async function grantFreeMonth(userId, months) {
  const { data: existing } = await supabase
    .from('subscriptions')
    .select('plan, status, pro_until, grant_source, stripe_subscription_id')
    .eq('user_id', userId)
    .maybeSingle();

  const addMs = months * 30 * 24 * 60 * 60 * 1000;

  // Never overwrite a real paid Stripe subscription.
  if (existing?.stripe_subscription_id) {
    return { granted: false, reason: 'already-paid', pro_until: null };
  }

  let pro_until;
  if (existing?.pro_until && new Date(existing.pro_until).getTime() > Date.now()) {
    // Stack grants — extend from the current expiry.
    pro_until = new Date(new Date(existing.pro_until).getTime() + addMs).toISOString();
  } else {
    pro_until = new Date(Date.now() + addMs).toISOString();
  }

  const row = {
    user_id: userId,
    plan: 'pro',
    status: 'active',
    pro_until,
    grant_source: '404-gift',
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('subscriptions')
    .upsert(row, { onConflict: 'user_id' });
  if (error) throw error;

  return { granted: true, pro_until };
}

async function generateMagicLink(email) {
  try {
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: REDIRECT },
    });
    if (error) throw error;
    return data?.properties?.action_link || data?.action_link || null;
  } catch (e) {
    console.error('[claim-freemonth] magic link error', e);
    return null;
  }
}

async function sendUserEmail({ email, name, months, magicLink, grant }) {
  if (!RESEND_API_KEY) return;
  if (!grant.granted) {
    // They already have a paid plan — just say thanks, don't promise free months.
    return resend({
      to: email,
      subject: "Thanks for flagging the broken link 💚",
      text:
`Hey ${name.split(' ')[0] || 'there'},

Thanks for letting us know about that broken link. Looks like you already have a paid subscription to YouTube Producer — so there's no free month to stack on top. We really appreciate the heads-up though.

If anything else feels off, hit reply on this email.

— Becky`,
    });
  }

  const firstName = name.split(' ')[0] || 'there';
  const monthsLabel = months === 2 ? 'two months' : 'one month';
  const until = new Date(grant.pro_until).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  const text =
`Hey ${firstName},

You found a broken link on youtubeproducer.app, so here's your thank-you: ${monthsLabel} of Pro, already activated on your account. No card needed, no action required from you.

${magicLink ? `Sign in here to start using it:\n${magicLink}\n\nThis link logs you in directly — no password.` : `Head to any tool on youtubeproducer.app and sign in with ${email} to use it.`}

Your free Pro access runs until ${until}.

Pro works across:
• Channel Audit — audit.youtubeproducer.app
• Podcast Packager — packager.youtubeproducer.app
• Quote Carousel — carousel.youtubeproducer.app

If anything's weird, reply to this email.

— Becky
youtubeproducer.app`;

  return resend({
    to: email,
    subject: `${monthsLabel[0].toUpperCase() + monthsLabel.slice(1)} of YouTube Producer Pro — on us 🎁`,
    text,
  });
}

async function notifyOwner(payload) {
  if (!RESEND_API_KEY) return;
  const subject = payload.error
    ? `[YT Producer] ⚠️ Free-month claim ERROR from ${payload.name || payload.email}`
    : `[YT Producer] Free-month claim from ${payload.name || payload.email}`;
  const lines = [
    `Name: ${payload.name}`,
    `Email: ${payload.email}`,
    `Months granted: ${payload.months}`,
    payload.grant ? `Result: ${payload.grant.granted ? 'granted until ' + payload.grant.pro_until : 'skipped (' + payload.grant.reason + ')'}` : null,
    `Source: ${payload.source}`,
    `Use case: ${payload.use_case}`,
    payload.source_detail ? `AI prompt / detail: ${payload.source_detail}` : null,
    '',
    `Broken path: ${payload.path}`,
    `Referrer: ${payload.referrer}`,
    `User agent: ${payload.userAgent}`,
    payload.userId ? `User ID: ${payload.userId}` : null,
    payload.note ? `Note: ${payload.note}` : null,
    payload.error ? `Error: ${payload.error}` : null,
    `Submitted: ${payload.ts}`,
  ].filter(Boolean).join('\n');
  return resend({ to: NOTIFY_TO, subject, text: lines, reply_to: payload.email });
}

async function resend({ to, subject, text, reply_to }) {
  try {
    const body = { from: FROM, to: [to], subject, text };
    if (reply_to) body.reply_to = reply_to;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) console.error('[claim-freemonth] resend failed', r.status, await r.text());
  } catch (e) {
    console.error('[claim-freemonth] resend error', e);
  }
}
