import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

function parseArgs(argv) {
  const parsed = {
    file: 'index.html',
    subject: process.env.NEWSLETTER_DEFAULT_SUBJECT || 'Un de vos clients a bougé.',
    campaign: process.env.NEWSLETTER_DEFAULT_CAMPAIGN || '',
    batchSize: 100,
    dryRun: false,
    confirm: false,
    resumeCampaign: false,
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
    else if (arg === '--resume-campaign') parsed.resumeCampaign = true;
    else if (arg === '--to') parsed.to = (argv[++i] || '').split(',').map((v) => v.trim()).filter(Boolean);
    else if (arg === '--only') parsed.only = (argv[++i] || '').split(',').map((v) => v.trim()).filter(Boolean);
    else if (arg === '--limit') parsed.limit = Number(argv[++i]);
  }

  return parsed;
}

async function fetchCampaignSentRecipients({ supabase, campaign, streamTag }) {
  const pageSize = 1000;
  let from = 0;
  const sent = new Set();

  while (true) {
    let query = supabase
      .from('newsletter_events')
      .select('recipient')
      .eq('campaign', campaign)
      .eq('event_type', 'email.sent')
      .not('recipient', 'is', null)
      .range(from, from + pageSize - 1);

    if (streamTag) {
      query = query.eq('stream', streamTag);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to query newsletter_events for resume: ${error.message}`);
    }

    if (!data || data.length === 0) {
      break;
    }

    for (const row of data) {
      const email = normalizeValidEmail(row.recipient);
      if (email) sent.add(email);
    }

    if (data.length < pageSize) {
      break;
    }

    from += pageSize;
  }

  return sent;
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

function extractEmailAddress(value) {
  const normalized = normalizeEmail(value);
  if (!normalized) return '';

  const namedAddress = normalized.match(/^[^<>]*<([^<>]+)>$/);
  return namedAddress ? namedAddress[1].trim() : normalized;
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
  const candidate = extractEmailAddress(email);
  if (!candidate || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(candidate)) {
    return false;
  }

  const [localPart, domain] = candidate.split('@');
  if (!localPart || !domain) return false;
  if (localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) return false;
  if (domain.includes('..')) return false;

  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (labels.some((label) => !label || label.startsWith('-') || label.endsWith('-'))) return false;
  if (labels[labels.length - 1].length < 2) return false;

  return true;
}

function normalizeValidEmail(value) {
  const email = extractEmailAddress(value);
  return isValidEmail(email) ? email : null;
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

async function fetchOptedOutEmails({ supabase, table, emailColumn, optInColumn, unsubscribedAtColumn }) {
  const optedOut = new Set();
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data } = await supabase
      .from(table)
      .select(emailColumn)
      .or(`${optInColumn}.eq.false,${unsubscribedAtColumn}.not.is.null`)
      .not(emailColumn, 'is', null)
      .range(from, from + pageSize - 1);

    if (!data || data.length === 0) break;

    for (const row of data) {
      const email = normalizeValidEmail(row[emailColumn]);
      if (email) optedOut.add(email);
    }

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return optedOut;
}

async function fetchSubscribers({
  supabase,
  table,
  emailColumn,
  firstNameColumn,
  optInColumn,
  unsubscribedAtColumn,
  limit
}) {
  const pageSize = 1000;
  let from = 0;
  const recipients = [];
  const firstNameByEmail = new Map();
  let invalidCount = 0;
  const invalidSamples = [];

  const selectColumns = firstNameColumn
    ? `${emailColumn}, ${firstNameColumn}`
    : emailColumn;

  while (true) {
    let query = supabase
      .from(table)
      .select(selectColumns)
      .eq(optInColumn, true)
      .is(unsubscribedAtColumn, null)
      .not(emailColumn, 'is', null)
      .order(emailColumn, { ascending: true })
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
      const email = normalizeValidEmail(row[emailColumn]);
      if (email) {
        recipients.push(email);
        if (firstNameColumn) {
          const firstName = String(row[firstNameColumn] || '').trim();
          if (firstName) firstNameByEmail.set(email, firstName);
        }
      } else {
        invalidCount += 1;
        if (invalidSamples.length < 10) {
          invalidSamples.push(normalizeEmail(row[emailColumn]));
        }
      }
    }

    if (limit && recipients.length >= limit) {
      break;
    }

    if (data.length < pageSize) {
      break;
    }

    from += pageSize;
  }

  // Deduplicate emails — one send per unique address regardless of how many rows exist
  const seen = new Set();
  const uniqueRecipients = [];
  for (const email of recipients) {
    if (!seen.has(email)) {
      seen.add(email);
      uniqueRecipients.push(email);
    }
  }

  // Exclude any email that has at least one opted-out row in the table
  // (protects against partial opt-outs across duplicate rows)
  const optedOutEmails = await fetchOptedOutEmails({ supabase, table, emailColumn, optInColumn, unsubscribedAtColumn });
  const activeRecipients = uniqueRecipients.filter(e => !optedOutEmails.has(e));

  return {
    recipients: activeRecipients,
    firstNameByEmail,
    rawCount: recipients.length,
    uniqueCount: uniqueRecipients.length,
    excludedOptOut: uniqueRecipients.length - activeRecipients.length,
    invalidCount,
    invalidSamples
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const resendApiKey = assertEnv('RESEND_API_KEY');
  const fromEmail = assertEnv('FROM_EMAIL');
  const replyToEmail = process.env.REPLY_TO_EMAIL || 'baala.mathis@gmail.com';

  const table = 'leads';
  const emailColumn = 'email';
  const firstNameColumn = 'first_name';
  const firstNameFallback = process.env.NEWSLETTER_FIRST_NAME_FALLBACK || '';
  const unsubscribeSecret = process.env.UNSUBSCRIBE_SECRET || '';
  const unsubscribeBaseUrl = (process.env.UNSUBSCRIBE_BASE_URL || '').replace(/\/+$/, '');
  const optInColumn = 'newsletter_opt_in';
  const unsubscribedAtColumn = 'unsubscribed_at';
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

  if (args.limit !== null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    throw new Error('--limit must be a positive number.');
  }

  const requestedLimit = Number.isFinite(args.limit) ? Math.floor(args.limit) : null;

  const htmlPath = path.resolve(args.file);
  const rawHtml = await fs.readFile(htmlPath, 'utf8');
  const hasFirstName = rawHtml.includes('{{PRENOM}}');
  const hasUnsubscribeUrl = rawHtml.includes('{{UNSUBSCRIBE_URL}}');
  const hasPersonalization = hasFirstName || hasUnsubscribeUrl;

  if (hasUnsubscribeUrl && !unsubscribeSecret) {
    throw new Error('UNSUBSCRIBE_SECRET is required when {{UNSUBSCRIBE_URL}} is used in the template.');
  }
  if (hasUnsubscribeUrl && !unsubscribeBaseUrl) {
    throw new Error('UNSUBSCRIBE_BASE_URL is required when {{UNSUBSCRIBE_URL}} is used in the template.');
  }
  const processedTemplate = await processImageAssets(rawHtml, path.dirname(htmlPath), publicAssetsBaseUrl);
  const html = processedTemplate.html;
  const inlineAttachments = processedTemplate.attachments;
  const imageMode = processedTemplate.mode;

  const resend = new Resend(resendApiKey);

  let fetched = {
    recipients: [],
    firstNameByEmail: new Map(),
    rawCount: 0,
    uniqueCount: 0,
    excludedOptOut: 0,
    invalidCount: 0,
    invalidSamples: []
  };

  let recipients = [];
  let firstNameByEmail = new Map();
  let supabase = null;

  if (!args.to || args.resumeCampaign) {
    const supabaseUrl = assertEnv('SUPABASE_URL');
    const supabaseServiceRoleKey = assertEnv('SUPABASE_SERVICE_ROLE_KEY');
    supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false }
    });
  }

  if (args.to && args.to.length > 0) {
    const normalizedTo = args.to.map(normalizeValidEmail);
    const manual = normalizedTo.filter(Boolean);
    const invalidManual = args.to
      .map((value, index) => ({ value: normalizeEmail(value), isValid: Boolean(normalizedTo[index]) }))
      .filter((entry) => !entry.isValid)
      .map((entry) => entry.value);
    recipients = Array.from(new Set(manual));
    fetched = {
      recipients,
      rawCount: manual.length,
      uniqueCount: recipients.length,
      invalidCount: invalidManual.length,
      invalidSamples: invalidManual.slice(0, 10)
    };
  } else {
    fetched = await fetchSubscribers({
      supabase,
      table,
      emailColumn,
      firstNameColumn: hasPersonalization ? firstNameColumn : null,
      optInColumn,
      unsubscribedAtColumn,
      // In resume mode, fetch full audience first, then slice after excluding already sent.
      limit: args.resumeCampaign ? null : requestedLimit
    });
    recipients = fetched.recipients;
    firstNameByEmail = fetched.firstNameByEmail;
  }

  if (args.only && args.only.length > 0) {
    const allowList = new Set(args.only.map(normalizeValidEmail).filter(Boolean));
    recipients = recipients.filter((email) => allowList.has(email));
  }

  const invalidRecipients = recipients.filter((email) => !isValidEmail(email));
  if (invalidRecipients.length > 0) {
    const sample = invalidRecipients.slice(0, 10).join(', ');
    console.warn(`[newsletter] warning: skipped ${invalidRecipients.length} invalid recipient(s). Sample: ${sample}`);
    const invalidSet = new Set(invalidRecipients);
    recipients = recipients.filter((email) => !invalidSet.has(email));
  }

  if (args.resumeCampaign) {
    if (!supabase) {
      throw new Error('Resume mode requires Supabase configuration.');
    }
    const alreadySent = await fetchCampaignSentRecipients({
      supabase,
      campaign: campaignTag,
      streamTag
    });
    const before = recipients.length;
    recipients = recipients.filter((email) => !alreadySent.has(email));
    const removed = before - recipients.length;
    console.log(`[newsletter] resume mode: excluded ${removed} already sent recipients for campaign ${campaignTag}.`);
  }

  if (requestedLimit) {
    const before = recipients.length;
    recipients = recipients.slice(0, requestedLimit);
    if (before > recipients.length) {
      console.log(`[newsletter] limit applied: ${requestedLimit} recipients selected.`);
    }
  }

  console.log(`[newsletter] template: ${htmlPath}`);
  console.log(`[newsletter] subject: ${args.subject}`);
  console.log(`[newsletter] raw rows fetched: ${fetched.rawCount}`);
  console.log(`[newsletter] unique emails: ${fetched.uniqueCount}`);
  if (fetched.excludedOptOut > 0) {
    console.log(`[newsletter] excluded (any row opted-out): ${fetched.excludedOptOut}`);
  }
  if (fetched.invalidCount > 0) {
    const sample = fetched.invalidSamples.join(', ');
    console.log(`[newsletter] skipped invalid emails: ${fetched.invalidCount}${sample ? ` (sample: ${sample})` : ''}`);
  }
  console.log(`[newsletter] recipients to send: ${recipients.length}`);
  if (hasFirstName) {
    console.log(`[newsletter] first name: on (column: ${firstNameColumn}, fallback: "${firstNameFallback || '(empty)'}", matched: ${firstNameByEmail.size}/${recipients.length})`);
  }
  if (hasUnsubscribeUrl) {
    console.log(`[newsletter] unsubscribe: on (base URL: ${unsubscribeBaseUrl})`);
  }
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

  const subjectHasFirstName = args.subject.includes('{{PRENOM}}');

  function resolveSubject(email) {
    if (!subjectHasFirstName) return args.subject;
    const firstName = firstNameByEmail.get(email) || firstNameFallback;
    return args.subject.replace(/\{\{PRENOM\}\}/g, firstName);
  }

  function resolveHtml(email) {
    if (!hasPersonalization) return html;
    let result = html;
    if (hasFirstName) {
      const firstName = firstNameByEmail.get(email) || firstNameFallback;
      result = result.replace(/\{\{PRENOM\}\}/g, firstName);
    }
    if (hasUnsubscribeUrl) {
      const token = crypto.createHmac('sha256', unsubscribeSecret).update(email).digest('hex');
      const url = `${unsubscribeBaseUrl}/unsubscribe?email=${encodeURIComponent(email)}&sig=${token}`;
      result = result.replace(/\{\{UNSUBSCRIBE_URL\}\}/g, url);
    }
    return result;
  }

  // Resend does not support attachments or per-recipient HTML on the batch endpoint.
  // Switch to individual send when attachments or personalization are present.
  const useIndividualSend = inlineAttachments.length > 0 || hasPersonalization;

  if (useIndividualSend) {
    if (inlineAttachments.length > 0) {
      console.log('[newsletter] attachments detected: switching to single-send mode (no batch).');
    }
    if (hasPersonalization) {
      console.log('[newsletter] personalization active: switching to single-send mode (no batch).');
    }

    for (let i = 0; i < recipients.length; i += 1) {
      const email = recipients[i];
      const { error } = await resend.emails.send({
        from: fromEmail,
        reply_to: replyToEmail,
        to: email,
        subject: resolveSubject(email),
        html: resolveHtml(email),
        ...(inlineAttachments.length > 0 ? { attachments: inlineAttachments } : {}),
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
        reply_to: replyToEmail,
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
