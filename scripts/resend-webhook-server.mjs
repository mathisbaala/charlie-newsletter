import 'dotenv/config';
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

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false }
});

const verifier = new Webhook(webhookSecret);

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { ok: true });
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
