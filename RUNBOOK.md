# RUNBOOK — hva som kan gå galt, og hva du gjør

Denne boka er skrevet for at du skal kunne løse problemet uten å lese kode.
Hver seksjon: **symptom → hva det betyr → nøyaktig hva du gjør.**

Sett dette øverst i bokmerkene:

```
STATUS   https://DITT-DOMENE/admin/status?token=DITT_ADMIN_TOKEN
HELSE    https://DITT-DOMENE/healthz
LOGGER   flyctl logs --app registervakt
KONSOLL  flyctl ssh console --app registervakt
SJEKK    flyctl ssh console --app registervakt --command "node scripts/doctor.js"
```

---

## Slik varsler systemet deg

Du får e-post til `ALERT_EMAIL` **kun** når noe faktisk er galt:

| Varsel | Utløses av | Hastegrad |
|---|---|---|
| «Noe er galt med driften» | Ingen vellykket polling på 6 timer, eller varsler som har feilet 5 ganger | Samme dag |
| «Jobben X feilet» | En planlagt jobb kastet en feil | Samme dag |
| «Uventet feil i prosessen» | Ubehandlet unntak | Samme dag |
| «Feil på /sti» | HTTP 500 i en forespørsel | Innen et par dager |
| «Ukentlig sikkerhetskopi» | Hver mandag 06:00 — dette er ikke en feil | Ingen |

Samme feil varsles **én gang per to timer**, ikke én gang per forekomst.
Antall undertrykte gjentakelser står nederst i e-posten.

**Får du ingen e-post, er alt i orden.** Det er hele poenget med oppsettet.

---

## 1. «Noe er galt med driften» — polling har stoppet

**Betyr:** Registervakt har ikke klart å hente endringer fra Brreg på seks timer.
Kunder får ikke varsler. Dette er den alvorligste feilen i systemet.

**Gjør dette, i rekkefølge:**

1. Sjekk om tjenesten lever:
   ```
   curl https://DITT-DOMENE/healthz
   ```
   - Får du ikke svar → gå til **seksjon 2**.
   - Får du `"status":"nede"` → fortsett her.

2. Se hva som feilet:
   ```
   flyctl logs --app registervakt | grep -i "jobb feilet"
   ```

3. Er Brreg nede? Sjekk kilden direkte:
   ```
   curl -s -o /dev/null -w "%{http_code}\n" \
     "https://data.brreg.no/enhetsregisteret/api/enheter/974760673"
   ```
   - `200` → Brreg er oppe, feilen er hos oss. Gå til punkt 4.
   - Annet enn `200` → **Brreg er nede. Gjør ingenting.** Systemet henter seg
     inn selv neste time, og markøren står stille så ingen endringer mistes.
     Sjekk igjen om et par timer.

4. Kjør pollingen manuelt og se feilmeldingen:
   ```
   curl -X POST "https://DITT-DOMENE/admin/kjor?jobb=poll&token=DITT_ADMIN_TOKEN"
   ```
   Svaret inneholder feilen ordrett.

5. Har Brreg endret API-et? Kjør full sjekk:
   ```
   flyctl ssh console --app registervakt --command "node scripts/doctor.js"
   ```
   Rapporten sier nøyaktig hvilket feltnavn eller endepunkt som ikke stemmer.
   Da må koden justeres — se **seksjon 8**.

---

## 2. Nettstedet svarer ikke i det hele tatt

**Betyr:** Maskinen er nede eller starter ikke.

```
flyctl status --app registervakt          # kjører maskinen?
flyctl logs --app registervakt | tail -50 # hvorfor døde den?
```

**Vanligste årsaker:**

| I loggen står det | Gjør dette |
|---|---|
| `Manglende produksjonskonfigurasjon: …` | En hemmelighet mangler. `flyctl secrets set --app registervakt NAVN=verdi` |
| `SQLITE_CANTOPEN` / `no such file` | Volumet er ikke montert. `flyctl volumes list --app registervakt` — mangler det, se seksjon 6 |
| `no space left on device` | Disken er full. Se **seksjon 5** |
| Ingenting, maskinen er stoppet | `flyctl machine start --app registervakt` |

Siste utvei — start på nytt:
```
flyctl apps restart registervakt
```

---

## 3. Kunder får ikke e-post

**Sjekk først om vi i det hele tatt prøvde:**
```
flyctl ssh console --app registervakt --command \
  "sqlite3 /data/registervakt.db 'SELECT status, COUNT(*) FROM mail_log WHERE created_at > datetime(\"now\",\"-1 day\") GROUP BY status'"
```

| Resultat | Betyr | Gjør |
|---|---|---|
| Ingen rader | Vi har ikke prøvd å sende — det er ikke funnet endringer. Ofte helt normalt. | Sjekk `/admin/status` for `hendelserSiste7Dager` |
| `failed` | Resend avviste utsendingen | Se under |
| `sent` | Vi sendte. Problemet er levering. | Se under |

**Ved `failed`:** kjør `node scripts/doctor.js`. De vanligste årsakene er at
`RESEND_API_KEY` er utløpt, eller at avsenderdomenet ikke lenger er verifisert.

**Ved `sent`, men kunden har ikke fått den:** be kunden sjekke søppelpost.
Skjer det med flere kunder, mangler du sannsynligvis SPF/DKIM/DMARC. Sjekk
domenestatusen i Resend-panelet.

**Ventende varsler tas automatisk opp igjen.** Ingenting går tapt ved en
forbigående e-postfeil — leveringen blir liggende som `pending` og prøves på
nytt ved neste runde, inntil fem forsøk.

Tving frem et nytt forsøk:
```
curl -X POST "https://DITT-DOMENE/admin/kjor?jobb=digest&token=DITT_ADMIN_TOKEN"
```

---

## 4. Kunde betalte, men fikk ingen tilgang

**Nesten alltid Stripe-webhooken.**

1. Åpne Stripe → Developers → Webhooks → ditt endepunkt. Se på feilede
   leveringer.
2. Peker endepunktet på `https://DITT-DOMENE/stripe/webhook`?
3. Er `STRIPE_WEBHOOK_SECRET` i Fly den samme som webhookens hemmelighet?
   Byttet du domene, er den ikke det.
4. Er disse hendelsene valgt? `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`,
   `invoice.payment_succeeded`.

**Rett det opp for kunden mens du feilsøker:** trykk «Resend» på hendelsen i
Stripe. Behandlingen er idempotent — kunden får ikke dobbelt velkomstbrev.

**Manuell nødløsning** (bruk bare hvis Stripe ikke kan sende på nytt):
```
flyctl ssh console --app registervakt
sqlite3 /data/registervakt.db \
  "INSERT INTO accounts (email, plan, status, api_key) VALUES ('kunde@firma.no','solo','active','rv_manuell');"
```
Be så kunden logge inn på `/logg-inn` — de får engangslenke på e-post.

---

## 5. Disken er full

SQLite-basen vokser sakte, men sikkerhetskopiene tar plass.

```
flyctl ssh console --app registervakt --command "df -h /data"
flyctl ssh console --app registervakt --command "du -sh /data/* | sort -h"
```

**Rydd:**
```
# Slett sikkerhetskopier eldre enn en uke (nattjobben gjør dette selv)
flyctl ssh console --app registervakt --command "find /data/backups -name '*.db' -mtime +7 -delete"

# Kjør oppryddingen manuelt
curl -X POST "https://DITT-DOMENE/admin/kjor?jobb=cleanup&token=DITT_ADMIN_TOKEN"
```

**Utvid volumet** hvis det er reelt fullt:
```
flyctl volumes extend VOLUME_ID --size 3 --app registervakt
```
Med under tusen kunder skal 1 GB holde i mange år.

---

## 6. Databasen er borte eller ødelagt

**Dette er den ene feilen som gjør varig skade.** Enhetsdata kan hentes inn
igjen fra Brreg, men kontoer og vaktlister kan ikke.

**Kilder til gjenoppretting, i prioritert rekkefølge:**

1. **Nattlig kopi på volumet** — `/data/backups/registervakt-ÅÅÅÅ-MM-DD.db`,
   sju dagers rullering.
   ```
   flyctl ssh console --app registervakt
   cp /data/backups/registervakt-2026-08-30.db /data/registervakt.db
   exit
   flyctl apps restart registervakt
   ```

2. **Den ukentlige CSV-en i innboksen din** — søk etter emnet
   «Ukentlig sikkerhetskopi». Den inneholder e-post, plan, status,
   Stripe-kundenummer og vaktliste for hver konto. Nok til å bygge opp
   kundeforholdene på nytt for hånd.

3. **Stripe** — hvem som betaler og hvor mye ligger uansett hos Stripe. Det
   som mangler der er kundenes vaktlister.

Etter gjenoppretting: `curl -X POST ".../admin/kjor?jobb=poll&token=…"` for å
hente ferske enhetsdata.

---

## 7. Markøren står fast, eller kunder får varsler om gammelt nytt

**Symptom:** samme hendelser gjentas, eller `/admin/status` viser at pollingen
kjører uten å finne noe over lang tid mens Brreg åpenbart har endringer.

Se hvor markøren står:
```
flyctl ssh console --app registervakt --command \
  "sqlite3 /data/registervakt.db \"SELECT * FROM kv WHERE key='brreg_oppdateringsid_enheter'\""
```

**Sett markøren på nytt** (systemet hopper da over historikken og starter
ferskt — ingen kunder får varsler for det som skjedde mens den sto fast):
```
flyctl ssh console --app registervakt --command \
  "sqlite3 /data/registervakt.db \"DELETE FROM kv WHERE key='brreg_oppdateringsid_enheter'\""
curl -X POST "https://DITT-DOMENE/admin/kjor?jobb=poll&token=DITT_ADMIN_TOKEN"
```

---

## 8. Brreg har endret API-et

**Symptom:** `doctor.js` melder «Enhet mangler påkrevd felt …» eller
«responsformen er ikke som antatt».

Dette er den mest sannsynlige *kodeendringen* du kommer til å trenge.

| Hva doctor melder | Hvilken fil du retter |
|---|---|
| Oppdateringsrad mangler et felt | `src/brreg.js`, funksjonen `normalizeUpdateItem` |
| `_embedded` bruker annet nøkkelnavn | Ingenting — adapteren håndterer det selv |
| Enhet mangler et felt | `src/diff.js`, funksjonen `normalizeEntity` |
| Adressen plukkes ikke opp | `src/diff.js`, funksjonen `joinAddress` |

Fremgangsmåte:
1. Se hva Brreg faktisk svarer:
   `curl -s "https://data.brreg.no/enhetsregisteret/api/enheter/974760673" | head -60`
2. Rett feltnavnet i riktig funksjon.
3. `npm test` — testene bruker et falskt Brreg-API og fanger opp om du brøt noe.
4. `./deploy.sh`

---

## 9. En kunde klager på at de fikk for mange, eller for få, varsler

**For mange:** be dem sette varslingsnivå til «Bare kritisk» under
Innstillinger, eller bytte til daglig oppsummering. Ingen kode skal endres.

**For få:** sjekk at selskapet er innenfor plangrensen. Følger de flere
selskaper enn planen dekker, varsles kun de eldste. Dashbordet merker de
overskytende med «Utenfor planen».

**«Jeg fikk ikke varsel om en konkurs»:** sjekk hendelsesloggen:
```
flyctl ssh console --app registervakt --command \
  "sqlite3 /data/registervakt.db \"SELECT * FROM events WHERE orgnr='912345678'\""
```
Finnes hendelsen ikke, har ikke Brreg registrert den ennå. Registeret
oppdateres nattlig, og en konkursåpning kan bruke noen dager på å nå
Enhetsregisteret. Det er en egenskap ved kilden, ikke en feil hos oss —
og det er derfor forsiden sier det uttrykkelig.

---

## 10. Rutinevedlikehold

**Månedlig (10 minutter):**
```
curl "https://DITT-DOMENE/admin/status?token=DITT_ADMIN_TOKEN" | jq
```
Se på `fastlaasteLeveringer` (skal være 0) og at `sisteOk` for `poll` er fersk.

**Kvartalsvis (30 minutter):**
```
npm outdated
npm update
npm test
./deploy.sh
```
Prosjektet har med vilje bare to avhengigheter — `stripe` og `better-sqlite3`.
Det gjør denne jobben liten, og det er en av grunnene til at den ble valgt.

**Årlig:** forny domenet. Sjekk at Stripe-avgiftene ikke har endret seg.
