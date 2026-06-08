#!/bin/bash
# Envoi planifié de l'édition RGPD (lundi 8 juin 2026, 10h00).
# Déclenché par le LaunchAgent com.charlie.newsletter.rgpd.
# Garde-fou : ne renvoie jamais deux fois (fichier sentinelle).

DIR="/Users/mathisbaala/Projects/charlie annexes/charlie-newsletter"
NODE="/Users/mathisbaala/.nvm/versions/node/v22.16.0/bin/node"
JQ="/usr/bin/jq"
EDITION="editions/2026-06-08.json"
SENTINEL="$DIR/.sent-rgpd-2026-06-08"
LOG="$DIR/send-rgpd-2026-06-08.log"

cd "$DIR" || exit 1

# Déjà envoyé ? on s'arrête.
if [ -f "$SENTINEL" ]; then
  echo "$(date) — déjà envoyé (sentinelle présente), abandon." >> "$LOG"
  exit 0
fi

SUBJECT="$("$JQ" -r .SUBJECT "$EDITION")"
CAMPAIGN="$("$JQ" -r .CAMPAIGN "$EDITION")"

echo "==== $(date) — DÉBUT envoi édition RGPD ====" >> "$LOG"
"$NODE" scripts/send-newsletter.mjs \
  --file index.html \
  --subject "$SUBJECT" \
  --campaign "$CAMPAIGN" \
  --confirm >> "$LOG" 2>&1
STATUS=$?

if [ $STATUS -eq 0 ]; then
  touch "$SENTINEL"
  echo "==== $(date) — FIN envoi OK ====" >> "$LOG"
else
  echo "==== $(date) — ÉCHEC (code $STATUS), sentinelle NON posée, réessai possible ====" >> "$LOG"
fi
exit $STATUS
