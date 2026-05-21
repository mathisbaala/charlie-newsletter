# editions/

Un fichier JSON par édition de la newsletter Intelligence Patrimoine.

## Convention de nommage

`AAAA-MM-JJ.json` — date d'envoi prévue (vendredi).

Exemple : `2026-05-23.json` pour l'édition du vendredi 23 mai 2026.

## Structure du JSON

Le fichier doit contenir une valeur pour chaque variable `{{NOM_MAJUSCULE}}` présente dans `template.html`, **à l'exception** de :

- `{{PRENOM}}` — injecté par `scripts/send-newsletter.mjs` au moment de l'envoi
- `{{UNSUBSCRIBE_URL}}` — idem

### Métadonnées d'envoi (lues par le builder, pas injectées dans le HTML)

- `SUBJECT` — objet du mail. Passé à `--subject` lors de l'envoi.
- `CAMPAIGN` — slug stable et unique, format `charlie_AAAA_MM_JJ_intelligence_patrimoine_NN_theme`. Passé à `--campaign`.
- `PREHEADER` — texte invisible affiché par Gmail/Outlook après l'objet. 90 caractères max recommandé.

### Champs textuels (escape HTML automatique)

`META_TITLE`, `EDITION_NUMBER`, `EDITION_DATE`, `EDITION_TAGLINE`, `SIGNAL_FIGURE`, `SIGNAL_UNIT`, `SIGNAL_TITLE`, `SIGNAL_ACTION`, `SIGNAL_SOURCE`, `CASE_ACTOR`, `CASE_TITLE`, `CASE_RESULT_FIGURE`, `TOOL_TITLE`, `TOOL_PROMPT_LABEL`, `TOOL_PROMPT_HINT`, `STAT_FIGURE`, `STAT_TITLE`, `STAT_SOURCE`, `CTA_LABEL`, `SIG_META`, `HOOK_TITLE`.

### Champs HTML-raw (acceptent `<strong>`, `<em>`, `<br>`, `<span class="hl|dim">`)

`HOOK_BODY`, `SIGNAL_TEXT_1`, `SIGNAL_TEXT_2`, `CASE_TRIGGER`, `CASE_ACTION`, `CASE_RESULT_TEXT`, `TOOL_TEXT`, `TOOL_PROMPT_BODY`, `STAT_TEXT`, `CTA_TITLE`, `CTA_TEXT`, `CTA_FALLBACK`.

### Champ URL (validation + escape attribut)

`CTA_URL` — doit être une URL HTTPS valide (pas de `javascript:`, `data:`, `vbscript:`).

## Spécificités syntaxiques

- **`HOOK_TITLE`** peut contenir `{{PRENOM}}` — il sera transmis tel quel et résolu à l'envoi.
- **`TOOL_PROMPT_BODY`** : utilisez `\n` pour les retours à la ligne (rendu en `pre-wrap` côté HTML), et `<span class="hl">...</span>` ou `<span class="dim">...</span>` pour le syntax highlighting du prompt.
- **`CTA_TITLE`** : utilisez `<em>...</em>` pour mettre en valeur en teal italique.

## Workflow

```bash
# 1. Copier la dernière édition comme base
cp editions/2026-05-23.json editions/2026-05-30.json

# 2. Mettre à jour le contenu

# 3. Build
npm run newsletter:build editions/2026-05-30.json

# 4. Vérifier index.html dans un navigateur

# 5. Test sur soi-même
node scripts/send-newsletter.mjs \
  --file index.html \
  --subject "$(jq -r .SUBJECT editions/2026-05-30.json)" \
  --campaign "$(jq -r .CAMPAIGN editions/2026-05-30.json)_test" \
  --to "vous@example.com" --confirm

# 6. Dry-run audience
npm run newsletter:dry -- \
  --subject "$(jq -r .SUBJECT editions/2026-05-30.json)" \
  --campaign "$(jq -r .CAMPAIGN editions/2026-05-30.json)"

# 7. Envoi
npm run newsletter:send -- \
  --subject "$(jq -r .SUBJECT editions/2026-05-30.json)" \
  --campaign "$(jq -r .CAMPAIGN editions/2026-05-30.json)"
```
