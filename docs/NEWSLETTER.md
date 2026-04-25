# Newsletter hebdomadaire (Supabase + Resend + analytics)

## 1) Installation

```bash
npm install
cp .env.example .env
```

Renseigne ensuite les variables dans `.env`.

## 2) One-time setup analytics

### 2.1 Base de données (Supabase)

Dans l'éditeur SQL Supabase, exécute:

- `docs/newsletter-metrics.sql`

Ce script crée:

- `public.newsletter_events` (table brute des événements webhook)
- `public.newsletter_campaign_metrics` (KPI par campagne)
- `public.newsletter_campaign_link_metrics` (top liens cliqués)

### 2.2 Tracking domaine Resend

Active le tracking opens/clicks et configure le subdomain tracking:

```bash
npm run newsletter:tracking:setup -- --tracking-subdomain links --verify
```

Remarques:

- Le domaine est déduit de `FROM_EMAIL`.
- Si les DNS ne sont pas prêts, le script affiche les records à configurer.
- Sans tracking activé + subdomain vérifié, tu n'auras pas d'`email.opened` / `email.clicked`.

### 2.3 Endpoint webhook

Lance le serveur webhook:

```bash
npm run newsletter:webhook:serve
```

Par défaut:

- URL locale: `http://localhost:8787/webhooks/resend`
- Healthcheck: `http://localhost:8787/health`

En production, publie ce endpoint via ton infra (VPS, Railway, Render, etc.).

### 2.4 Enregistrer le webhook dans Resend

Une fois ton endpoint public disponible, crée/maj le webhook:

```bash
npm run newsletter:webhook:setup -- --endpoint "https://your-app.example.com/webhooks/resend"
```

Le script retourne un `signing_secret`:

- copie-le dans `.env` sous `RESEND_WEBHOOK_SECRET`

Événements suivis par défaut:

- `email.sent`
- `email.delivered`
- `email.opened`
- `email.clicked`
- `email.bounced`
- `email.complained`
- `email.delivery_delayed`
- `email.failed`
- `email.suppressed`

## 3) Préparer la table abonnés

Le script d'envoi suppose ces colonnes:

- table `public.members` (ou override via env)
- `email` (text)
- `newsletter_opt_in` (boolean)
- `unsubscribed_at` (timestamptz)

SQL rapide:

```sql
alter table public.members
add column if not exists newsletter_opt_in boolean default false;

alter table public.members
add column if not exists unsubscribed_at timestamptz;
```

Si ta table/colonnes ont d'autres noms, ajuste dans `.env`:

- `NEWSLETTER_SUBSCRIBERS_TABLE`
- `NEWSLETTER_EMAIL_COLUMN`
- `NEWSLETTER_OPT_IN_COLUMN`
- `NEWSLETTER_UNSUBSCRIBED_AT_COLUMN`

## 4) Workflow hebdo d'envoi

1. Mets à jour le contenu dans `index.html`.
2. Prévisualise l'audience sans envoi:

```bash
npm run newsletter:dry -- --subject "CHARLIE #14" --campaign "charlie_2026_04_24"
```

3. Envoi global:

```bash
npm run newsletter:send -- --subject "CHARLIE #14" --campaign "charlie_2026_04_24"
```

4. Envoi test sur une adresse (hors base abonnés):

```bash
node scripts/send-newsletter.mjs \
  --file index.html \
  --subject "CHARLIE #14 - test" \
  --campaign "charlie_2026_04_24_test" \
  --to "toi@domaine.com" \
  --confirm
```

Notes:

- Chaque envoi est taggé automatiquement avec:
  - `campaign=<...>`
  - `stream=<NEWSLETTER_STREAM_TAG>`
- `--to` envoie directement à une liste d'emails (pratique pour QA, sans dépendre de la table Supabase).
- Si des images inline sont détectées, l'envoi passe en mode unitaire (pas de batch Resend avec attachments).

## 5) Lire les métriques

### CLI

Toutes campagnes:

```bash
npm run newsletter:metrics
```

Une campagne précise + top liens:

```bash
npm run newsletter:metrics -- --campaign "charlie_2026_04_24" --links
```

### Dashboard/SQL Supabase

```sql
select *
from public.newsletter_campaign_metrics
order by last_event_at desc;

select *
from public.newsletter_campaign_link_metrics
where campaign = 'charlie_2026_04_24'
order by unique_clicks desc;
```

## 6) Variables d'environnement ajoutées

- `RESEND_TRACKING_SUBDOMAIN` (ex: `links`)
- `NEWSLETTER_DEFAULT_CAMPAIGN`
- `NEWSLETTER_STREAM_TAG`
- `NEWSLETTER_WEBHOOK_ENDPOINT`
- `NEWSLETTER_WEBHOOK_PORT`
- `NEWSLETTER_WEBHOOK_PATH`
- `RESEND_WEBHOOK_SECRET`

## 7) Bonnes pratiques

- Toujours renseigner `--campaign` (stable et unique par envoi).
- Ne jamais exposer `SUPABASE_SERVICE_ROLE_KEY` côté frontend.
- Vérifier les signatures webhook (`svix`) avant insertion DB.
- Utiliser `clicked` comme signal d'engagement plus fiable que `opened`.
