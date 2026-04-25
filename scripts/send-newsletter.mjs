import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

function parseArgs(argv) {
  const parsed = {
    file: 'index.html',
    subject: process.env.NEWSLETTER_DEFAULT_SUBJECT || 'Charlie Newsletter',
    campaign: process.env.NEWSLETTER_DEFAULT_CAMPAIGN || '',
    batchSize: 100,
    dryRun: false,
    confirm: false,
    to: null,
    only: null,
    limit: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--file') parsed.file = argv[++i];
    else if (arg === '--subject') parsed.subject = argv[++i];
    else if (arg === '--campaign') parsed.campaign = argv[++i];
    else if (arg === '--batch-size') parsed.batchSize = Number(argv[++i]);
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--confirm') parsed.confirm = true;
    else if (arg === '--to') parsed.to = (argv[++i] || '').split(',').map((v) => v.trim()).filter(Boolean);
    else if (arg === '--only') parsed.only = (argv[++i] || '').split(',').map((v) => v.trim()).filter(Boolean);
    else if (arg === '--limit') parsed.limit = Number(argv[++i]);
  }

  return parsed;
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
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

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function sanitizeTagValue(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 256);

  return normalized || 'newsletter';
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isLocalImageSrc(src) {
  return !/^(https?:|data:|cid:|mailto:|#|\/\/)/i.test(src);
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function sanitizeCidPart(value) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

function replaceImageSrc(imgTag, nextSrc) {
  if (/\bsrc=(["']).*?\1/i.test(imgTag)) {
    return imgTag.replace(/\bsrc=(["']).*?\1/i, `src="${nextSrc}"`);
  }
  return imgTag.replace(/<img/i, `<img src="${nextSrc}"`);
}

function normalizePublicAssetsBaseUrl(value) {
  const base = (value || '').trim();
  if (!base) return null;
  return base.replace(/\/+$/, '');
}

function buildPublicAssetUrl(baseUrl, localSrc) {
  const cleanSrc = String(localSrc || '').replace(/^\.\//, '');
  return `${baseUrl}/${cleanSrc}`;
}

async function processImageAssets(html, htmlDir, publicAssetsBaseUrl) {
  const imgTagRegex = /<img\b[^>]*>/gi;
  const assetsBySrc = new Map();
  const normalizedBaseUrl = normalizePublicAssetsBaseUrl(publicAssetsBaseUrl);
  const mode = normalizedBaseUrl ? 'hybrid' : 'cid';

  let tagMatch;
  while ((tagMatch = imgTagRegex.exec(html)) !== null) {
    const imgTag = tagMatch[0];
    const srcMatch = imgTag.match(/\bsrc=(["'])([^"']+)\1/i);
    const src = srcMatch?.[2]?.trim();

    if (!src || !isLocalImageSrc(src) || assetsBySrc.has(src)) continue;

    const filePath = path.resolve(htmlDir, src);

    try {
      const content = await fs.readFile(filePath);
      const filename = path.basename(filePath);
      const cid = `asset-${assetsBySrc.size + 1}-${sanitizeCidPart(filename)}`;

      assetsBySrc.set(src, {
        cid,
        publicUrl: normalizedBaseUrl ? buildPublicAssetUrl(normalizedBaseUrl, src) : null,
        attachment: {
          filename,
          content: content.toString('base64'),
          contentType: guessMimeType(filePath),
          inlineContentId: cid
        }
      });
    } catch (error) {
      console.warn(`[newsletter] warning: unable to inline asset "${src}" (${error.message})`);
    }
  }

  const processedHtml = html.replace(imgTagRegex, (imgTag) => {
    const srcMatch = imgTag.match(/\bsrc=(["'])([^"']+)\1/i);
    const src = srcMatch?.[2]?.trim();
    if (!src) return imgTag;

    const asset = assetsBySrc.get(src);
    if (!asset) return imgTag;

    const cidTag = replaceImageSrc(imgTag, `cid:${asset.cid}`);
    if (mode === 'hybrid' && asset.publicUrl) {
      const publicTag = replaceImageSrc(imgTag, asset.publicUrl);
      return `<!--[if mso]>${cidTag}<![endif]--><!--[if !mso]><!-->${publicTag}<!--<![endif]-->`;
    }
    return cidTag;
  });

  return {
    mode,
    html: processedHtml,
    attachments: Array.from(assetsBySrc.values()).map((v) => v.attachment)
  };
}

async function fetchSubscribers({
  supabase,
  table,
  emailColumn,
  optInColumn,
  unsubscribedAtColumn,
  limit
}) {
  const pageSize = 1000;
  let from = 0;
  const recipients = [];

  while (true) {
    let query = supabase
      .from(table)
      .select(emailColumn)
      .eq(optInColumn, true)
      .is(unsubscribedAtColumn, null)
      .not(emailColumn, 'is', null)
      .range(from, from + pageSize - 1);

    if (limit) {
      query = query.limit(Math.max(0, limit - recipients.length));
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Supabase query failed: ${error.message}`);
    }

    if (!data || data.length === 0) {
      break;
    }

    for (const row of data) {
      const email = normalizeEmail(row[emailColumn]);
      if (isValidEmail(email)) recipients.push(email);
    }

    if (limit && recipients.length >= limit) {
      break;
    }

    if (data.length < pageSize) {
      break;
    }

    from += pageSize;
  }

  const uniqueRecipients = Array.from(new Set(recipients));

  return {
    recipients: uniqueRecipients,
    rawCount: recipients.length,
    uniqueCount: uniqueRecipients.length
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const resendApiKey = assertEnv('RESEND_API_KEY');
  const fromEmail = assertEnv('FROM_EMAIL');

  const table = process.env.NEWSLETTER_SUBSCRIBERS_TABLE || 'members';
  const emailColumn = process.env.NEWSLETTER_EMAIL_COLUMN || 'email';
  const optInColumn = process.env.NEWSLETTER_OPT_IN_COLUMN || 'newsletter_opt_in';
  const unsubscribedAtColumn = process.env.NEWSLETTER_UNSUBSCRIBED_AT_COLUMN || 'unsubscribed_at';
  const publicAssetsBaseUrl = process.env.NEWSLETTER_PUBLIC_ASSETS_BASE_URL || '';
  const streamTag = sanitizeTagValue(process.env.NEWSLETTER_STREAM_TAG || 'charlie_newsletter');
  const campaignTag = sanitizeTagValue(args.campaign || args.subject);
  const resendTags = [
    { name: 'stream', value: streamTag },
    { name: 'campaign', value: campaignTag }
  ];

  if (!args.dryRun && !args.confirm) {
    throw new Error('Safety check: add --confirm to send emails, or use --dry-run to preview.');
  }

  if (!Number.isFinite(args.batchSize) || args.batchSize <= 0 || args.batchSize > 500) {
    throw new Error('--batch-size must be between 1 and 500.');
  }

  const htmlPath = path.resolve(args.file);
  const rawHtml = await fs.readFile(htmlPath, 'utf8');
  const processedTemplate = await processImageAssets(rawHtml, path.dirname(htmlPath), publicAssetsBaseUrl);
  const html = processedTemplate.html;
  const inlineAttachments = processedTemplate.attachments;
  const imageMode = processedTemplate.mode;

  const resend = new Resend(resendApiKey);

  let fetched = {
    recipients: [],
    rawCount: 0,
    uniqueCount: 0
  };

  let recipients = [];

  if (args.to && args.to.length > 0) {
    const manual = args.to.map(normalizeEmail).filter(isValidEmail);
    recipients = Array.from(new Set(manual));
    fetched = {
      recipients,
      rawCount: manual.length,
      uniqueCount: recipients.length
    };
  } else {
    const supabaseUrl = assertEnv('SUPABASE_URL');
    const supabaseServiceRoleKey = assertEnv('SUPABASE_SERVICE_ROLE_KEY');
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false }
    });

    fetched = await fetchSubscribers({
      supabase,
      table,
      emailColumn,
      optInColumn,
      unsubscribedAtColumn,
      limit: Number.isFinite(args.limit) ? args.limit : null
    });
    recipients = fetched.recipients;
  }

  if (args.only && args.only.length > 0) {
    const allowList = new Set(args.only.map(normalizeEmail));
    recipients = recipients.filter((email) => allowList.has(email));
  }

  console.log(`[newsletter] template: ${htmlPath}`);
  console.log(`[newsletter] subject: ${args.subject}`);
  console.log(`[newsletter] raw valid emails: ${fetched.rawCount}`);
  console.log(`[newsletter] unique emails: ${fetched.uniqueCount}`);
  console.log(`[newsletter] removed duplicates: ${Math.max(0, fetched.rawCount - fetched.uniqueCount)}`);
  console.log(`[newsletter] recipients: ${recipients.length}`);
  console.log(`[newsletter] inline assets: ${inlineAttachments.length}`);
  console.log(`[newsletter] image mode: ${imageMode}`);
  console.log(`[newsletter] stream tag: ${streamTag}`);
  console.log(`[newsletter] campaign tag: ${campaignTag}`);
  if (args.to && args.to.length > 0) {
    console.log('[newsletter] source: direct --to recipients');
  }
  if (imageMode === 'hybrid' && publicAssetsBaseUrl) {
    console.log(`[newsletter] public assets base URL: ${publicAssetsBaseUrl}`);
  }

  if (recipients.length === 0) {
    console.log('[newsletter] no recipients found, nothing to send.');
    return;
  }

  if (args.dryRun) {
    const sample = recipients.slice(0, 10).join(', ');
    console.log(`[newsletter] dry-run enabled. Sample: ${sample}`);
    return;
  }

  // Resend does not support attachments on the batch endpoint.
  // If we have inline assets (CID images), send one by one.
  if (inlineAttachments.length > 0) {
    console.log('[newsletter] attachments detected: switching to single-send mode (no batch).');

    for (let i = 0; i < recipients.length; i += 1) {
      const email = recipients[i];
      const { error } = await resend.emails.send({
        from: fromEmail,
        to: email,
        subject: args.subject,
        html,
        attachments: inlineAttachments,
        tags: resendTags
      });

      if (error) {
        throw new Error(`Resend send failed at ${i + 1}/${recipients.length} (${email}): ${error.message}`);
      }

      console.log(`[newsletter] sent ${i + 1}/${recipients.length} (${email})`);
    }
  } else {
    const groups = chunk(recipients, args.batchSize);

    for (let i = 0; i < groups.length; i += 1) {
      const batch = groups[i];
      const payload = batch.map((email) => ({
        from: fromEmail,
        to: email,
        subject: args.subject,
        html,
        tags: resendTags
      }));

      const { error } = await resend.batch.send(payload);

      if (error) {
        throw new Error(`Resend batch failed at ${i + 1}/${groups.length}: ${error.message}`);
      }

      console.log(`[newsletter] sent batch ${i + 1}/${groups.length} (${batch.length} emails)`);
    }
  }

  console.log(`[newsletter] done: ${recipients.length} emails sent.`);
}

main().catch((error) => {
  console.error(`[newsletter] error: ${error.message}`);
  process.exit(1);
});
