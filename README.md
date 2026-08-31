# Registervakt

Overvåker Enhetsregisteret og varsler når selskaper du følger endrer seg —
konkurs, tvangsavvikling, sletting, navnebytte, adresseendring, næringskode,
MVA-registrering eller antall ansatte.

Data hentes fra Brønnøysundregistrenes åpne API. Ingen kredittvurdering, ingen
personopplysninger om roller, ingen scraping.

**Start her:** [HANDOVER.md](HANDOVER.md) — sjekkliste før lansering, kostnader
og break-even.
**Når noe går galt:** [RUNBOOK.md](RUNBOOK.md).
**Hvorfor akkurat dette produktet:** [IDEAS.md](IDEAS.md) og
[VALIDATION.md](VALIDATION.md).

---

## Kom i gang lokalt

```bash
npm install
npm test                 # 101 tester, ingen nett nødvendig
npm run dev              # http://localhost:8080
```

I utviklingsmodus går e-post til konsollen i stedet for å sendes, og betaling
er avslått til du legger inn Stripe-nøkler.

```bash
npm run doctor           # sjekker Brreg, Stripe og Resend mot ekte tjenester
./deploy.sh              # ett-kommandos deploy til Fly.io
```

---

## Hvordan det virker

```
Brreg /oppdateringer/enheter        én global endringsstrøm, hentes én gang
        |
        |  markør på oppdateringsid — hullfri og idempotent
        v
  kryss mot alle kunders vaktlister  ett SQL-oppslag
        |
        v
  hent kun de enhetene noen følger   /enheter/{orgnr}
        |
        v
  diff mot lagret snapshot           src/diff.js, ren funksjon
        |
        v
  hendelser  ->  leveringer per kunde  ->  e-post / Slack / webhook
```

Det avgjørende trekket er at endringsstrømmen hentes **én gang per runde**,
ikke én gang per kunde. Femti kunder som følger samme selskap gir tre kall mot
Brreg, ikke femti. Marginalkostnaden per kunde er derfor tilnærmet null, og det
er verifisert med en test.

---

## Kode

| Fil | Ansvar |
|---|---|
| `src/brreg.js` | Klient mot Brregs API. Defensiv mot avvik i nøkkelnavn |
| `src/diff.js` | Normaliserer enheter og finner endringer. Ren funksjon, ingen sideeffekter |
| `src/entities.js` | Snapshots og lagring av hendelser |
| `src/watches.js` | Vaktlister og fan-out-oppslaget |
| `src/notify.js` | Fra hendelse til e-post, Slack og webhook |
| `src/jobs.js` | Polling, daglig oppsummering, vakthund, opprydding, kopi |
| `src/scheduler.js` | Kjører jobbene. Leser siste kjøring fra basen, så omstart verken dobler eller hopper over |
| `src/stripe.js` | Checkout, portal og webhook. Idempotent per event-id |
| `src/server.js` | Alle ruter |
| `src/views.js` | Serverrendret HTML. Ingen byggesteg, ingen frontend-rammeverk |

To avhengigheter totalt: `stripe` og `better-sqlite3`. Det er et bevisst valg —
avhengigheter er den viktigste kilden til vedlikehold over tid.

---

## Tester

```bash
npm test
```

101 tester, alle uten nett. Hele pollesløyfen kjøres mot et falskt Brreg-API
(`test/helpers/fake-brreg.js`) som etterlikner det dokumenterte formatet,
og Stripe mot en attrapp.

Dekker blant annet: mod-11-validering av organisasjonsnumre, CSV-import,
alle hendelsestyper, varslingsnivåer, plangrenser, nedgradering,
idempotens i Stripe-webhooken, at kunder ikke ser hverandres data, CSRF,
takstbegrensning, og at vakthunden er stille når alt er i orden.

---

## Drift

| | |
|---|---|
| Kjører på | Fly.io, én maskin i Stockholm |
| Lagring | SQLite på et montert volum |
| E-post | Resend |
| Betaling | Stripe Checkout og Billing Portal |
| Helsesjekk | `GET /healthz` — 503 når pollingen er for gammel |
| Driftsoversikt | `GET /admin/status?token=…` |
| Kjør en jobb manuelt | `POST /admin/kjor?jobb=poll&token=…` |

Maskinen må stå på hele tiden — planleggeren kjører inne i prosessen.
`auto_stop_machines = "off"` i `fly.toml` sørger for det.
