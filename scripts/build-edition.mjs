#!/usr/bin/env node
/**
 * build-edition.mjs
 *
 * Construit un index.html prêt à envoyer à partir de :
 *   - un template HTML avec variables {{NOM_MAJUSCULE}}
 *   - un fichier JSON d'édition contenant les valeurs
 *
 * Usage :
 *   node scripts/build-edition.mjs editions/2026-05-23.json
 *   node scripts/build-edition.mjs editions/2026-05-23.json --out index.html
 *   node scripts/build-edition.mjs editions/2026-05-23.json --template template.html
 *
 * Les variables {{PRENOM}} et {{UNSUBSCRIBE_URL}} ne sont PAS injectées : elles
 * sont consommées plus tard par scripts/send-newsletter.mjs au moment de l'envoi.
 *
 * Champs HTML-raw (acceptent <strong>, <em>, <span class="hl|dim">, etc.) :
 *   HOOK_BODY, SIGNAL_TEXT_1, SIGNAL_TEXT_2, CASE_TRIGGER, CASE_ACTION,
 *   CASE_RESULT_TEXT, TOOL_TEXT, TOOL_PROMPT_BODY, STAT_TEXT,
 *   CTA_TITLE, CTA_TEXT, CTA_FALLBACK
 *
 * Champ URL (escape attribut HTML) : CTA_URL
 *
 * Tous les autres champs : escape HTML standard.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const RUNTIME_VARS = new Set(['PRENOM', 'UNSUBSCRIBE_URL']);

const HTML_RAW_VARS = new Set([
  // V3 legacy
  'HOOK_BODY',
  'SIGNAL_TEXT_1',
  'SIGNAL_TEXT_2',
  'CASE_TRIGGER',
  'CASE_ACTION',
  'CASE_RESULT_TEXT',
  'TOOL_TEXT',
  'TOOL_PROMPT_BODY',
  'STAT_TEXT',
  'CTA_TITLE',
  'CTA_TEXT',
  'CTA_FALLBACK',
  // V4 Éditorial — corps pouvant contenir <strong>, <em>
  'S1_BODY', 'S1_LEAD',
  'S2_BODY', 'S2_LEAD', 'S2_B1', 'S2_B2', 'S2_B3',
  'S3_BODY', 'S3_LEAD', 'S3_QUOTE',
  'S3_B1', 'S3_B2', 'S3_B3',
  'S4_LEAD', 'S4_STEP_1', 'S4_STEP_2', 'S4_STEP_3', 'S4_STEP_4',
  'TOOL_PITCH'
]);

const URL_VARS = new Set([
  'CTA_URL',
  'HERO_URL',
  'TOOL_LOGO_URL',
  'TOOL_LINK_URL',
  'WEBVIEW_URL',
  'PREFERENCES_URL',
]);

const VAR_PATTERN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

function parseArgs(argv) {
  const parsed = { json: null, template: 'template.html', out: 'index.html' };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') parsed.out = argv[++i];
    else if (arg === '--template') parsed.template = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    } else if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}`);
      printHelpAndExit(1);
    } else {
      positional.push(arg);
    }
  }

  parsed.json = positional[0] || null;
  return parsed;
}

function printHelpAndExit(code) {
  const msg = [
    'Usage: node scripts/build-edition.mjs <edition.json> [--template template.html] [--out index.html]',
    '',
    'Builds index.html by injecting JSON content into the HTML template.',
    'Runtime variables {{PRENOM}} and {{UNSUBSCRIBE_URL}} are left untouched.'
  ].join('\n');
  if (code === 0) console.log(msg);
  else console.error(msg);
  process.exit(code);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isSafeUrl(value) {
  const v = String(value).trim();
  if (!v) return true; // URL vide = autorisée (img/href sans src)
  if (/^javascript:/i.test(v)) return false;
  if (/^data:/i.test(v)) return false;
  if (/^vbscript:/i.test(v)) return false;
  return true;
}

function extractTemplateVars(template) {
  const found = new Set();
  for (const match of template.matchAll(VAR_PATTERN)) {
    found.add(match[1]);
  }
  return found;
}

function injectVariables(template, data) {
  return template.replace(VAR_PATTERN, (_full, name) => {
    if (RUNTIME_VARS.has(name)) {
      return `{{${name}}}`;
    }
    const raw = data[name];
    if (raw === undefined || raw === null) {
      return `{{${name}}}`;
    }
    if (URL_VARS.has(name)) {
      if (!isSafeUrl(raw)) {
        throw new Error(`Unsafe URL value for variable ${name}: ${raw}`);
      }
      return escapeAttr(raw);
    }
    if (HTML_RAW_VARS.has(name)) {
      return String(raw);
    }
    return escapeHtml(raw);
  });
}

async function readJson(file) {
  const raw = await fs.readFile(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${err.message}`);
  }
}

function formatSize(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.json) {
    console.error('Error: missing JSON edition file.\n');
    printHelpAndExit(1);
  }

  const jsonPath = path.resolve(args.json);
  const templatePath = path.resolve(args.template);
  const outPath = path.resolve(args.out);

  const [template, data] = await Promise.all([
    fs.readFile(templatePath, 'utf8'),
    readJson(jsonPath)
  ]);

  const templateVars = extractTemplateVars(template);
  const contentVars = new Set(
    [...templateVars].filter((name) => !RUNTIME_VARS.has(name))
  );

  const provided = new Set(Object.keys(data));
  const missing = [...contentVars].filter((name) => !provided.has(name));

  if (missing.length > 0) {
    console.error('Build failed — missing variables in JSON:\n');
    for (const name of missing) console.error(`  - ${name}`);
    console.error(`\nJSON file: ${jsonPath}`);
    console.error(`Template:  ${templatePath}`);
    process.exit(1);
  }

  const unknown = [...provided].filter(
    (name) => /^[A-Z][A-Z0-9_]*$/.test(name) && !templateVars.has(name)
  );

  const output = injectVariables(template, data);

  const stillUnresolved = new Set();
  for (const match of output.matchAll(VAR_PATTERN)) {
    if (!RUNTIME_VARS.has(match[1])) stillUnresolved.add(match[1]);
  }

  if (stillUnresolved.size > 0) {
    console.error('Build failed — unresolved variables after injection:');
    for (const name of stillUnresolved) console.error(`  - ${name}`);
    process.exit(1);
  }

  await fs.writeFile(outPath, output, 'utf8');
  const { size } = await fs.stat(outPath);

  console.log('Newsletter build OK');
  console.log(`  edition JSON : ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`  template     : ${path.relative(process.cwd(), templatePath)}`);
  console.log(`  output       : ${path.relative(process.cwd(), outPath)} (${formatSize(size)})`);
  console.log(`  subject      : ${data.SUBJECT || '(non défini)'}`);
  console.log(`  campaign     : ${data.CAMPAIGN || '(non défini)'}`);
  console.log(`  preheader    : ${data.PREHEADER || '(non défini)'}`);
  if (unknown.length > 0) {
    console.log(`  warning      : ${unknown.length} variable(s) du JSON non utilisée(s) par le template :`);
    for (const name of unknown) console.log(`                 · ${name}`);
  }
}

main().catch((err) => {
  console.error(`build-edition: ${err.message}`);
  process.exit(1);
});
