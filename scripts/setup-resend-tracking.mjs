import 'dotenv/config';

function parseArgs(argv) {
  const out = {
    domain: '',
    trackingSubdomain: process.env.RESEND_TRACKING_SUBDOMAIN || 'links',
    verify: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--domain') out.domain = argv[++i] || '';
    else if (arg === '--tracking-subdomain') out.trackingSubdomain = argv[++i] || out.trackingSubdomain;
    else if (arg === '--verify') out.verify = true;
  }

  return out;
}

function assertEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function extractDomainFromFromEmail(fromEmail) {
  const match = String(fromEmail || '').match(/@([^>\s]+)\s*>?$/);
  return (match?.[1] || '').trim().toLowerCase();
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const fromEmail = assertEnv('FROM_EMAIL');
  const senderDomain = extractDomainFromFromEmail(fromEmail);
  const domainName = (args.domain || senderDomain).toLowerCase();

  if (!domainName) {
    throw new Error('Unable to detect sender domain. Use --domain example.com');
  }

  const listResponse = await resendRequest('/domains');
  const domains = Array.isArray(listResponse?.data) ? listResponse.data : [];
  const domain = domains.find((item) => String(item?.name || '').toLowerCase() === domainName);

  if (!domain) {
    throw new Error(`Domain not found in Resend account: ${domainName}`);
  }

  try {
    await resendRequest(`/domains/${domain.id}`, {
      method: 'PATCH',
      body: {
        open_tracking: true,
        click_tracking: true,
        tracking_subdomain: args.trackingSubdomain
      }
    });
  } catch (error) {
    const message = String(error.message).toLowerCase();
    if (message.includes('once every 24 hours')) {
      console.warn('[tracking] warning: tracking subdomain was updated recently; skipping PATCH for now.');
    } else if (message.includes('tracking domain with the subdomain') && message.includes('already exists')) {
      console.warn('[tracking] warning: tracking subdomain already exists for this domain; keeping current configuration.');
    } else {
      throw error;
    }
  }

  if (args.verify) {
    await resendRequest(`/domains/${domain.id}/verify`, { method: 'POST' });
  }

  const refreshed = await resendRequest(`/domains/${domain.id}`);
  const info = refreshed;

  console.log(`[tracking] domain: ${info.name}`);
  console.log(`[tracking] status: ${info.status}`);
  console.log(`[tracking] open_tracking: ${info.open_tracking}`);
  console.log(`[tracking] click_tracking: ${info.click_tracking}`);
  console.log(`[tracking] tracking_subdomain: ${info.tracking_subdomain || 'none'}`);

  const trackingRecords = Array.isArray(info.records)
    ? info.records.filter((r) => String(r?.name || '').includes(args.trackingSubdomain))
    : [];

  if (trackingRecords.length > 0) {
    console.log('[tracking] DNS records to verify:');
    for (const record of trackingRecords) {
      const priority = record.priority ? ` priority=${record.priority}` : '';
      console.log(`- ${record.type} ${record.name} => ${record.value}${priority} [${record.status}]`);
    }
  }
}

main().catch((error) => {
  console.error(`[tracking] error: ${error.message}`);
  process.exit(1);
});
