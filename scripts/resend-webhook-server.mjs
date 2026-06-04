import 'dotenv/config';
import crypto from 'node:crypto';
import http from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { Webhook } from 'svix';

function assertEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeTagValue(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeTags(rawTags) {
  if (!rawTags) return {};

  if (Array.isArray(rawTags)) {
    return rawTags.reduce((acc, tag) => {
      const name = normalizeTagValue(tag?.name);
      const value = normalizeTagValue(tag?.value);
      if (name) acc[name] = value;
      return acc;
    }, {});
  }

  if (typeof rawTags === 'object') {
    return Object.entries(rawTags).reduce((acc, [key, value]) => {
      const name = normalizeTagValue(key);
      const normalizedValue = normalizeTagValue(value);
      if (name) acc[name] = normalizedValue;
      return acc;
    }, {});
  }

  return {};
}

function buildRows(payload, webhookId) {
  const data = payload?.data || {};
  const tags = normalizeTags(data.tags);
  const recipients = Array.isArray(data.to) && data.to.length > 0 ? data.to : [''];
  const eventCreatedAt = payload?.created_at || data?.created_at || new Date().toISOString();
  const clickLink = data?.click?.link ? String(data.click.link) : null;
  const clickTimestamp = data?.click?.timestamp || null;

  return recipients.map((recipient, index) => {
    const normalizedRecipient = normalizeEmail(recipient);
    const eventRecipient = normalizedRecipient || null;

    return {
      event_key: `${webhookId}:${index}:${normalizedRecipient || 'none'}`,
      webhook_id: webhookId,
      event_type: String(payload?.type || ''),
      event_created_at: eventCreatedAt,
      email_id: data?.email_id || null,
      broadcast_id: data?.broadcast_id || null,
      recipient: eventRecipient,
      sender: data?.from || null,
      subject: data?.subject || null,
      campaign: tags.campaign || null,
      stream: tags.stream || null,
      click_link: clickLink,
      click_timestamp: clickTimestamp,
      tags,
      payload
    };
  });
}

const supabaseUrl = assertEnv('SUPABASE_URL');
const supabaseServiceRoleKey = assertEnv('SUPABASE_SERVICE_ROLE_KEY');
const webhookSecret = assertEnv('RESEND_WEBHOOK_SECRET');

const port = Number(process.env.NEWSLETTER_WEBHOOK_PORT || process.env.PORT || 8787);
const webhookPath = process.env.NEWSLETTER_WEBHOOK_PATH || '/webhooks/resend';

const unsubscribeSecret = process.env.UNSUBSCRIBE_SECRET || '';
const subscribersTable = 'leads';
const emailColumn = 'email';
const optInColumn = 'newsletter_opt_in';
const unsubscribedAtColumn = 'unsubscribed_at';

function generateUnsubscribeToken(email) {
  return crypto.createHmac('sha256', unsubscribeSecret).update(email).digest('hex');
}

function verifyUnsubscribeToken(email, token) {
  const expected = generateUnsubscribeToken(email);
  const expectedBuf = Buffer.from(expected, 'hex');
  let tokenBuf;
  try {
    tokenBuf = Buffer.from(token, 'hex');
  } catch {
    return false;
  }
  if (tokenBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(tokenBuf, expectedBuf);
}

function unsubscribePage(success, message) {
  const color = success ? '#9A4222' : '#8A2B1A';
  const icon = success ? '✓' : '✕';
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Charlie · Désabonnement</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#F4EFE4;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#FCFAF4;border:1px solid #E2DACB;border-radius:8px;max-width:440px;width:100%;padding:48px 40px;text-align:center}.icon{width:48px;height:48px;border-radius:50%;background:${color};color:#fff;font-size:22px;line-height:48px;margin:0 auto 24px}.title{font-size:20px;font-weight:700;color:#2B2722;margin-bottom:12px}.text{font-size:14px;line-height:1.7;color:#857D72}.site{display:block;margin-top:28px;font-size:12px;color:#ADA79E;text-decoration:none}a{color:#9A4222}</style></head><body><div class="card"><div class="icon">${icon}</div><p class="title">${success ? 'Vous êtes désabonné' : 'Lien invalide'}</p><p class="text">${message}</p><a class="site" href="https://www.charliefinancialadvisor.com">charliefinancialadvisor.com</a></div></body></html>`;
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false }
});

const verifier = new Webhook(webhookSecret);

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendHtml(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && req.url?.startsWith('/unsubscribe')) {
      if (!unsubscribeSecret) {
        console.error('[unsubscribe] UNSUBSCRIBE_SECRET not configured');
        return sendHtml(res, 500, unsubscribePage(false, 'Configuration manquante. Contactez l\'administrateur.'));
      }

      const params = new URL(req.url, `http://localhost:${port}`).searchParams;
      const email = (params.get('email') || '').trim().toLowerCase();
      const token = params.get('sig') || '';

      if (!email || !token) {
        return sendHtml(res, 400, unsubscribePage(false, 'Lien de désabonnement invalide.'));
      }

      if (!verifyUnsubscribeToken(email, token)) {
        return sendHtml(res, 400, unsubscribePage(false, 'Lien de désabonnement invalide ou expiré.'));
      }

      // Update ALL rows for this email — a prospect can have multiple rows (one per document)
      // We mark every row as opted-out so no duplicate row can slip through the send filter
      const { error } = await supabase
        .from(subscribersTable)
        .update({
          [unsubscribedAtColumn]: new Date().toISOString(),
          [optInColumn]: false
        })
        .eq(emailColumn, email);

      if (error) {
        console.error('[unsubscribe] supabase error:', error.message);
        return sendHtml(res, 500, unsubscribePage(false, 'Une erreur est survenue. Réessayez dans quelques instants.'));
      }

      console.log(`[unsubscribe] ${email} désabonné`);
      return sendHtml(res, 200, unsubscribePage(true, `L'adresse <strong>${email}</strong> a été retirée de la liste. Vous ne recevrez plus d'emails de notre part.`));
    }

    if (req.method !== 'POST' || req.url !== webhookPath) {
      return sendJson(res, 404, { error: 'Not found' });
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const rawBody = Buffer.concat(chunks).toString('utf8');

    const svixId = req.headers['svix-id'];
    const svixTimestamp = req.headers['svix-timestamp'];
    const svixSignature = req.headers['svix-signature'];

    if (!svixId || !svixTimestamp || !svixSignature) {
      return sendJson(res, 400, { error: 'Missing Svix headers' });
    }

    let payload;
    try {
      payload = verifier.verify(rawBody, {
        'svix-id': String(svixId),
        'svix-timestamp': String(svixTimestamp),
        'svix-signature': String(svixSignature)
      });
    } catch {
      return sendJson(res, 400, { error: 'Invalid webhook signature' });
    }

    const rows = buildRows(payload, String(svixId));

    if (rows.length === 0) {
      return sendJson(res, 200, { ok: true, inserted: 0 });
    }

    const { error } = await supabase
      .from('newsletter_events')
      .upsert(rows, { onConflict: 'event_key', ignoreDuplicates: true });

    if (error) {
      console.error('[webhook] supabase upsert error:', error.message);
      return sendJson(res, 500, { error: 'Database upsert failed' });
    }

    console.log(`[webhook] stored ${rows.length} row(s) for event ${payload?.type || 'unknown'} (${svixId})`);
    return sendJson(res, 200, { ok: true, inserted: rows.length });
  } catch (error) {
    console.error('[webhook] unhandled error:', error.message);
    return sendJson(res, 500, { error: 'Unhandled server error' });
  }
});

server.listen(port, () => {
  console.log(`[webhook] listening on http://localhost:${port}${webhookPath}`);
  console.log('[webhook] health endpoint: /health');
});
