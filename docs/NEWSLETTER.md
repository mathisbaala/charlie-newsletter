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
- `docs/newsletter-subscribers.sql`
- `docs/drop-newsletter-subscribers.sql` (une fois `leads` vérifiée)

Ces scripts créent:

- `public.newsletter_events` (table brute des événements webhook)
- `public.newsletter_campaign_metrics` (KPI par campagne)
- `public.newsletter_campaign_link_metrics` (top liens cliqués)
- `public.leads` (table abonnés/prospects utilisée par les scripts)

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

Le workflow (envoi + unsubscribe) est maintenant fixé sur `public.leads`:

- table `public.leads`
- `email` (text)
- `first_name` (text)
- `newsletter_opt_in` (boolean)
- `unsubscribed_at` (timestamptz)

SQL recommandé:

```sql
-- crée/normalise la table leads :
-- docs/newsletter-subscribers.sql
```

Ce script normalise le schéma de `leads` et garantit les contraintes utilisées par les scripts.
Ensuite supprime la table obsolète:

```sql
-- supprime newsletter_subscribers :
-- docs/drop-newsletter-subscribers.sql
```

## Workflow hebdo V2 — Intelligence Patrimoine

Depuis l'édition #17 (23 mai 2026), le contenu vit dans des fichiers JSON sous `editions/` et est injecté dans `template.html` par un builder Node natif. `index.html` n'est plus édité à la main — il est généré à chaque édition.

### Architecture

- `template.html` : template email avec variables `{{NOM}}`. Architecture en 5 blocs (HOOK, SIGNAL, CAS, OUTIL, CHIFFRE) + CTA founder-led + footer. Inchangé entre les éditions.
- `editions/AAAA-MM-JJ.json` : valeurs des variables pour une édition donnée. Un fichier par envoi.
- `scripts/build-edition.mjs` : builder Node natif, zéro dépendance. Lit le JSON + le template, écrit `index.html`.

Voir `editions/README.md` pour la liste complète des variables et la convention de nommage.

### Flow hebdomadaire

1. **Copier la dernière édition** comme base :
   ```bash
   cp editions/2026-05-23.json editions/AAAA-MM-JJ.json
   ```

2. **Remplir les variables** dans le nouveau JSON (HOOK_TITLE, SIGNAL_*, CASE_*, TOOL_*, STAT_*, CTA_*, etc.). Garder le filtre "propriétaire / actionnable / démonstratif" en tête : chaque édition doit contenir au moins un signal extrait d'une source publique exploitée par Charlie (BODACC, DVF, SIRENE, INPI, AMF) et un outil utilisable dans les 48h.

3. **Build** :
   ```bash
   npm run newsletter:build editions/AAAA-MM-JJ.json
   ```
   Le builder valide que toutes les variables du template sont présentes dans le JSON et échoue sinon. Sortie : `index.html` à la racine. Les variables `{{PRENOM}}` et `{{UNSUBSCRIBE_URL}}` restent dans le fichier — elles sont injectées au moment de l'envoi.

4. **Vérifier visuellement** en ouvrant `index.html` dans un navigateur.

5. **Test sur soi-même** (hors base abonnés) :
   ```bash
   node scripts/send-newsletter.mjs \
     --file index.html \
     --subject "$(node -e "console.log(require('./editions/AAAA-MM-JJ.json').SUBJECT)")" \
     --campaign "$(node -e "console.log(require('./editions/AAAA-MM-JJ.json').CAMPAIGN)")_test" \
     --to "vous@example.com" --confirm
   ```

6. **Dry-run** pour vérifier l'audience :
   ```bash
   npm run newsletter:dry -- \
     --subject "..." \
     --campaign "charlie_AAAA_MM_JJ_intelligence_patrimoine_NN_theme"
   ```

7. **Blast** :
   ```bash
   npm run newsletter:send -- \
     --subject "..." \
     --campaign "charlie_AAAA_MM_JJ_intelligence_patrimoine_NN_theme"
   ```

## 4) Workflow hebdo d'envoi (legacy)

> Conservé pour référence — préférer désormais le workflow V2 ci-dessus.

1. Mets à jour le contenu dans `index.html`.
2. Prévisualise l'audience sans envoi:

```bash
npm run newsletter:dry -- --subject "Un de vos clients a bougé." --campaign "charlie_2026_05_11_data_gouv_pappers_mcp"
```

3. Envoi global:

```bash
npm run newsletter:send -- --subject "Un de vos clients a bougé." --campaign "charlie_2026_05_11_data_gouv_pappers_mcp"
```

4. Envoi test sur une adresse (hors base abonnés):

```bash
node scripts/send-newsletter.mjs \
  --file index.html \
  --subject "Un de vos clients a bougé. - test" \
  --campaign "charlie_2026_05_11_data_gouv_pappers_mcp_test" \
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
npm run newsletter:metrics -- --campaign "charlie_2026_05_11_data_gouv_pappers_mcp" --links
```

### Dashboard/SQL Supabase

```sql
select *
from public.newsletter_campaign_metrics
order by last_event_at desc;

select *
from public.newsletter_campaign_link_metrics
where campaign = 'charlie_2026_05_11_data_gouv_pappers_mcp'
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
