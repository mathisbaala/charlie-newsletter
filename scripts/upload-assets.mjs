// Upload des images de la newsletter vers Supabase Storage (bucket public).
// Garantit des URLs servies par le CDN Supabase, indépendantes du site Vercel.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BUCKET = 'newsletter';

const ASSETS = [
  { file: 'hero-42.jpg', type: 'image/jpeg' },
  { file: 'charlie-logo.png', type: 'image/png' },
  { file: 'mathis-baala.jpg', type: 'image/jpeg' },
];

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant dans .env');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

// Bucket public, idempotent.
const { error: bucketErr } = await supabase.storage.createBucket(BUCKET, {
  public: true,
  fileSizeLimit: '5MB',
});
if (bucketErr && !/already exists/i.test(bucketErr.message)) {
  console.error('Erreur création bucket:', bucketErr.message);
  process.exit(1);
}
// S'assure qu'il est bien public même s'il existait déjà.
await supabase.storage.updateBucket(BUCKET, { public: true });

for (const { file, type } of ASSETS) {
  const bytes = readFileSync(resolve(ROOT, file));
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(file, bytes, { contentType: type, upsert: true, cacheControl: '31536000' });
  if (error) {
    console.error(`✗ ${file}:`, error.message);
    process.exit(1);
  }
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(file);
  console.log(`✓ ${file} -> ${data.publicUrl}`);
}

console.log('\nBase URL:', `${url}/storage/v1/object/public/${BUCKET}`);
