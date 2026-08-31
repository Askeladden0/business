#!/usr/bin/env bash
# Ett-kommandos deploy av Registervakt til Fly.io.
#
#   ./deploy.sh
#
# Skriptet er idempotent: det kan kjøres om igjen uten å ødelegge noe.
# Første gang oppretter det app, volum og hemmeligheter. Deretter deployer det
# bare ny kode.
set -euo pipefail

APP="${FLY_APP:-registervakt}"
REGION="${FLY_REGION:-arn}"
VOLUME="registervakt_data"
VOLUME_GB="${FLY_VOLUME_GB:-1}"

info() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
feil() { printf '\033[31mFEIL: %s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '\033[32m  ok\033[0m %s\n' "$1"; }

command -v flyctl >/dev/null 2>&1 || feil "flyctl er ikke installert. Se https://fly.io/docs/flyctl/install/"
flyctl auth whoami >/dev/null 2>&1 || feil "Du er ikke innlogget. Kjør: flyctl auth login"

info "Kjører testene før deploy"
npm test >/dev/null 2>&1 || feil "Testene feiler. Deployer ikke."
ok "alle tester er grønne"

info "App"
if flyctl apps list 2>/dev/null | grep -qE "^${APP}\s"; then
  ok "appen «${APP}» finnes"
else
  flyctl apps create "$APP" --machines
  ok "opprettet appen «${APP}»"
fi

info "Volum (SQLite-databasen bor her)"
if flyctl volumes list --app "$APP" 2>/dev/null | grep -q "$VOLUME"; then
  ok "volumet «${VOLUME}» finnes"
else
  flyctl volumes create "$VOLUME" --app "$APP" --region "$REGION" --size "$VOLUME_GB" --yes
  ok "opprettet volumet «${VOLUME}» (${VOLUME_GB} GB) i ${REGION}"
fi

info "Hemmeligheter"
# Leses fra .env hvis den finnes; ellers må de allerede være satt i Fly.
PAAKREVDE=(
  BASE_URL
  STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_SOLO STRIPE_PRICE_BYRAA
  RESEND_API_KEY MAIL_FROM
  ALERT_EMAIL ADMIN_TOKEN
)
VALGFRIE=(BRAND_NAME SUPPORT_EMAIL MAIL_REPLY_TO ORG_NAME ORG_NUMBER STRIPE_TRIAL_DAYS)

if [ -f .env ]; then
  ARGS=()
  MANGLER=()
  for NAVN in "${PAAKREVDE[@]}" "${VALGFRIE[@]}"; do
    VERDI="$(grep -E "^${NAVN}=" .env | tail -1 | cut -d= -f2- | sed 's/^"//; s/"$//' || true)"
    if [ -n "$VERDI" ] && [[ "$VERDI" != *bytt_meg* ]]; then
      ARGS+=("${NAVN}=${VERDI}")
    elif printf '%s\n' "${PAAKREVDE[@]}" | grep -qx "$NAVN"; then
      MANGLER+=("$NAVN")
    fi
  done

  if [ ${#MANGLER[@]} -gt 0 ]; then
    printf '\033[33m  obs\033[0m mangler i .env: %s\n' "${MANGLER[*]}"
    printf '        de må enten stå i .env eller allerede være satt i Fly.\n'
  fi
  if [ ${#ARGS[@]} -gt 0 ]; then
    flyctl secrets set --app "$APP" --stage "${ARGS[@]}" >/dev/null
    ok "la inn ${#ARGS[@]} hemmeligheter (tas i bruk ved neste deploy)"
  fi
else
  printf '\033[33m  obs\033[0m ingen .env funnet — antar at hemmelighetene alt er satt i Fly.\n'
  printf '        Sett dem med: flyctl secrets set --app %s NAVN=verdi\n' "$APP"
fi

info "Deployer"
flyctl deploy --app "$APP" --ha=false --wait-timeout 300

info "Helsesjekk"
URL="$(flyctl status --app "$APP" --json 2>/dev/null | grep -o '"Hostname":"[^"]*"' | head -1 | cut -d'"' -f4)"
URL="${URL:-${APP}.fly.dev}"
sleep 5
if curl -fsS --max-time 20 "https://${URL}/healthz" >/dev/null 2>&1; then
  ok "https://${URL}/healthz svarer"
else
  printf '\033[33m  obs\033[0m /healthz svarte ikke ennå. Sjekk: flyctl logs --app %s\n' "$APP"
fi

info "Ferdig"
cat <<SLUTT
  Nettsted:      https://${URL}
  Logger:        flyctl logs --app ${APP}
  Status:        flyctl status --app ${APP}
  Driftsoversikt: https://${URL}/admin/status?token=DITT_ADMIN_TOKEN

  Kjør sjekken mot ekte tjenester nå:
    flyctl ssh console --app ${APP} --command "node scripts/doctor.js"

  Husk at Stripe-webhooken må peke på https://${URL}/stripe/webhook
SLUTT
