import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

function parseArgs(argv) {
  const out = {
    campaign: '',
    limit: 20,
    links: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--campaign') out.campaign = String(argv[++i] || '');
    else if (arg === '--limit') out.limit = Number(argv[++i]);
    else if (arg === '--links') out.links = true;
  }

  if (!Number.isFinite(out.limit) || out.limit <= 0) {
    out.limit = 20;
  }

  return out;
}

function assertEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function pad(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : `${text}${' '.repeat(width - text.length)}`;
}

function pct(value) {
  if (value === null || value === undefined) return '-';
  return `${Number(value).toFixed(2)}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const supabase = createClient(assertEnv('SUPABASE_URL'), assertEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false }
  });

  let metricsQuery = supabase
    .from('newsletter_campaign_metrics')
    .select('*')
    .order('last_event_at', { ascending: false })
    .limit(args.limit);

  if (args.campaign) {
    metricsQuery = metricsQuery.eq('campaign', args.campaign);
  }

  const { data: campaigns, error: campaignsError } = await metricsQuery;
  if (campaignsError) {
    throw new Error(`Failed to load campaign metrics: ${campaignsError.message}`);
  }

  if (!campaigns || campaigns.length === 0) {
    console.log('[metrics] no campaign metrics found.');
    return;
  }

  console.log('Campaign metrics');
  console.log(
    [
      pad('campaign', 24),
      pad('delivered', 10),
      pad('opened', 8),
      pad('clicked', 8),
      pad('open_rate', 10),
      pad('ctr', 8),
      pad('ctor', 8),
      'last_event_at'
    ].join(' | ')
  );

  for (const row of campaigns) {
    console.log(
      [
        pad(row.campaign, 24),
        pad(row.delivered_unique, 10),
        pad(row.opened_unique, 8),
        pad(row.clicked_unique, 8),
        pad(pct(row.open_rate_pct), 10),
        pad(pct(row.ctr_pct), 8),
        pad(pct(row.ctor_pct), 8),
        row.last_event_at
      ].join(' | ')
    );
  }

  if (!args.links) return;

  let linksQuery = supabase
    .from('newsletter_campaign_link_metrics')
    .select('*')
    .order('unique_clicks', { ascending: false })
    .limit(args.limit);

  if (args.campaign) {
    linksQuery = linksQuery.eq('campaign', args.campaign);
  }

  const { data: links, error: linksError } = await linksQuery;
  if (linksError) {
    throw new Error(`Failed to load link metrics: ${linksError.message}`);
  }

  console.log('\nTop clicked links');
  if (!links || links.length === 0) {
    console.log('[metrics] no link clicks found.');
    return;
  }

  for (const row of links) {
    console.log(`- [${row.campaign}] unique=${row.unique_clicks} total=${row.total_clicks} ${row.click_link}`);
  }
}

main().catch((error) => {
  console.error(`[metrics] error: ${error.message}`);
  process.exit(1);
});
