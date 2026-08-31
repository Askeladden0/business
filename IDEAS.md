# Fase 1 — Idékandidater og rangering

Kriterier alle kandidater måtte oppfylle: ett smalt problem, betalingsvillig
nisje (B2B foretrukket), byggbart av én agent uten menneskelig arbeid i
produktet, ingen support-tung brukergruppe, ingen brukergenerert innhold eller
moderering, ingen lisens-/sertifiseringskrav eller regulert bransje,
marginalkostnad nær null per kunde.

Rangeringen er `(inntektspotensial × sannsynlighet) ÷ vedlikeholdsbyrde`.
Skalaer: inntektspotensial 1–10 (realistisk MRR innen 12 mnd),
sannsynlighet 0–1 (at det faktisk får betalende kunder),
vedlikehold 1–10 (10 = konstant stell). Score = (I × S) ÷ V.

| # | Idé | Kjøper | I | S | V | Score |
|---|-----|--------|---|---|---|-------|
| 1 | **Endringsvarsling på Enhetsregisteret** — overvåk en liste orgnr, varsle ved konkurs, tvangsavvikling, sletting, navne-/adresse-/næringskode-/MVA-endring | Regnskapsbyrå, inkasso, B2B-selgere, forsikringsmeglere, utleiere | 6 | 0.55 | 2 | **1.65** |
| 2 | OpenAPI-spec drift-overvåking for API-konsumenter | Utviklingsteam | 6 | 0.35 | 4 | 0.53 |
| 3 | Anbudsvarsling fra TED/Doffin på nøkkelord | Konsulenter, SMB som byr | 7 | 0.30 | 5 | 0.42 |
| 4 | Strukturert data / JSON-LD-overvåking for SEO-byrå | SEO-byrå | 4 | 0.35 | 4 | 0.35 |
| 5 | Konkurrenters prisside-overvåking (SaaS) | Produkt-/markedsteam | 6 | 0.40 | 8 | 0.30 |
| 6 | Statusside-aggregator for leverandøravhengigheter | DevOps | 4 | 0.30 | 4 | 0.30 |
| 7 | SSL-/DNS-/domene-utløpsovervåking for MSP | MSP, IT-drift | 4 | 0.35 | 5 | 0.28 |
| 8 | Lisensendringsvarsling for OSS-avhengigheter (BSL-bytter o.l.) | Plattformteam | 3 | 0.30 | 3 | 0.30 |
| 9 | LLM-synlighet / merkevareomtale i AI-svar | Markedsavdelinger | 8 | 0.35 | 6 | 0.47 |
| 10 | Nettsted-uptime + Core Web Vitals | Alle | 3 | 0.20 | 5 | 0.12 |

## Hvorfor de andre falt

- **#5, #9**: marginalkostnad er ikke nær null. Prisside-overvåking krever
  scraping med anti-bot-motstand (høyt vedlikehold, ødelagte selektorer).
  LLM-synlighet krever LLM-kall per kunde per spørring — kostnad skalerer
  lineært med kunder, og markedet fylles av godt finansierte aktører.
- **#2**: reell etterspørsel, men den billige enden gis bort gratis
  (`oasdiff`, `openapi-changes` er gratis OSS; FlareCanary er gratis for 5
  endepunkter), og Optic — den mest kjente aktøren — er lagt ned. Kjøperen er
  en utvikler som bruker egen lommebok. Lav betalingsvilje.
- **#3**: mettet. TenderMetric er gratis, og Mercell/Stotles/TenderWolf/Jorpex
  dekker segmentet med langt større datagrunnlag enn jeg kan matche.
- **#7, #10**: gratis alternativer (UptimeRobot) dekker jobben.
- **#4, #6, #8**: for små markeder til å forsvare byggetiden.

## Valgt vinner: #1 — Endringsvarsling på Enhetsregisteret

Begrunnelse (5 setninger):

1. Datakilden er ett gratis, offentlig, godt dokumentert API fra
   Brønnøysundregistrene med en ferdig delta-strøm (`/oppdateringer/enheter`) —
   ingen scraping, ingen selektorer som ryker, altså minimal vedlikeholdsbyrde.
2. Marginalkostnaden er ikke bare lav, den er **O(1) i antall kunder**: én
   daglig gjennomgang av den globale endringsstrømmen matches mot alle kunders
   vaktlister samtidig, så kunde nr. 500 koster praktisk talt det samme som
   kunde nr. 1.
3. Kjøperen er en bedriftsfunksjon med budsjett (regnskapsbyrå, inkasso,
   kredittoppfølging, B2B-salg) — ikke en utvikler som betaler av egen lomme.
4. Dagens alternativer er dyre, salgsstyrte kredittopplysningspakker uten
   offentlig pris (Proff Forvalt, Creditsafe, Bisnode), så den selvbetjente,
   transparent prisede enden av markedet står åpen.
5. Produktet er ren varsling om faktiske registerendringer fra åpne data —
   ingen kredittscoring, ingen personopplysninger om styremedlemmer, ingen
   moderering, ingen brukergenerert innhold, og dermed ingen konsesjonskrav.
