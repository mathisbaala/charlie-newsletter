import 'dotenv/config';

function parseArgs(argv) {
  const out = {
    endpoint: process.env.NEWSLETTER_WEBHOOK_ENDPOINT || '',
    events: [
      'email.sent',
      'email.delivered',
      'email.opened',
      'email.clicked',
      'email.bounced',
      'email.complained',
      'email.delivery_delayed',
      'email.failed',
      'email.suppressed'
    ]
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--endpoint') out.endpoint = argv[++i] || out.endpoint;
    else if (arg === '--events') {
      out.events = String(argv[++i] || '')
        .split(',')
        .map((eventName) => eventName.trim())
        .filter(Boolean);
    }
  }

  return out;
}

function assertEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function resendRequest(path, { method = 'GET', body } = {}) {
  const apiKey = assertEnv('RESEND_API_KEY');

  const response = await fetch(`https://api.resend.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'charlie-newsletter/1.0'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.message || payload?.error || JSON.stringify(payload) || `HTTP ${response.status}`;
    throw new Error(`Resend API ${method} ${path} failed: ${message}`);
  }
  return payload;
}

function unwrapResource(payload) {
  if (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') {
    return payload.data;
  }
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.endpoint) {
    throw new Error('Missing webhook endpoint. Use --endpoint or NEWSLETTER_WEBHOOK_ENDPOINT');
  }

  const events = Array.from(new Set(args.events));

  const listed = await resendRequest('/webhooks');
  const hooks = Array.isArray(listed?.data) ? listed.data : [];
  const existing = hooks.find((hook) => String(hook?.endpoint || '') === args.endpoint);

  let webhook;
  let mode;

  if (existing) {
    const updated = unwrapResource(await resendRequest(`/webhooks/${existing.id}`, {
      method: 'PATCH',
      body: {
        endpoint: args.endpoint,
        events,
        status: 'enabled'
      }
    }));
    webhook = unwrapResource(await resendRequest(`/webhooks/${updated.id || existing.id}`));
    mode = 'updated';
  } else {
    const created = unwrapResource(await resendRequest('/webhooks', {
      method: 'POST',
      body: {
        endpoint: args.endpoint,
        events
      }
    }));
    webhook = unwrapResource(await resendRequest(`/webhooks/${created.id}`));
    mode = 'created';
  }

  console.log(`[webhook] ${mode}: ${webhook.id}`);
  console.log(`[webhook] endpoint: ${webhook.endpoint}`);
  console.log(`[webhook] events: ${(webhook.events || events).join(', ')}`);

  if (webhook.signing_secret) {
    console.log('[webhook] copy this to .env as RESEND_WEBHOOK_SECRET:');
    console.log(webhook.signing_secret);
  } else {
    console.log('[webhook] signing_secret not returned. Open Resend dashboard > Webhooks to retrieve it.');
  }
}

main().catch((error) => {
  console.error(`[webhook] error: ${error.message}`);
  process.exit(1);
});
