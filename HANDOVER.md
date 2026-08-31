# HANDOVER — Registervakt

Alt er bygget, testet og klart til å deployes. Det som gjenstår er det jeg
ikke kan gjøre uten deg: kjøpe ting, opprette kontoer hos tredjeparter, og
verifisere mot ekte API-er.

**Les punkt 0 først.** Det er den ene tingen som må gjøres før alt annet.

---

## 0. Det viktigste forbeholdet

Jeg bygde dette i et miljø der utgående nett var sperret mot alt annet enn
npm og GitHub. Jeg har **aldri kunnet kalle det ekte Brreg-API-et, Stripe
eller Resend**. Feltnavn og responsformer er utledet fra Brregs dokumentasjon,
ikke fra en levende respons.

Det er håndtert på tre måter, men det er ikke det samme som verifisert:

1. Brreg-adapteren er skrevet defensivt og tåler at nøkkelnavn avviker.
2. Hele pollesløyfen kjøres i testene mot et falskt Brreg-API som etterlikner
   det dokumenterte formatet. 101 tester, alle grønne.
3. `npm run doctor` kaller de ekte tjenestene og sier presist hvilken antakelse
   som eventuelt ikke holder, og hvilken funksjon som må rettes.

**Steg 1 under er derfor blokkerende.** Fungerer doctor, er du trygg. Melder
den avvik, står det i RUNBOOK.md seksjon 8 nøyaktig hvor i koden det rettes —
det er snakk om feltnavn, ikke arkitektur.

Jeg har heller ikke kunnet bygge Docker-imaget (ingen Docker-daemon i miljøet).
Dockerfilen er standard og `npm ci --omit=dev` er verifisert; `better-sqlite3`
har ferdigbygde binærfiler for linux-x64, så bygget skal ikke trenge å
kompilere noe.

---

## 1. Sjekkliste før lansering

Regn med **3–4 timer** totalt. Punkt 1–6 kan gjøres i ett strekk.

### 1. Verifiser Brreg-antakelsene — GJØR DETTE FØRST
```
git clone <dette repoet> && cd business
npm install
npm test                    # skal gi 101 grønne
npm run doctor
```
Doctor vil klage på manglende Stripe- og Resend-nøkler — det er forventet nå.
**Det du ser etter er Brreg-seksjonen.** Alt grønt der betyr at kjernen virker.
Rødt der: se RUNBOOK.md seksjon 8 før du går videre.

### 2. Kjøp domene
Et `.no`-domene koster ca. 150–250 kr/år (Domeneshop, Domene.shop, One.com).
Velg noe kort. Navnet «Registervakt» er ikke sjekket mot Foretaksregisteret
eller varemerkeregisteret — gjør det før du trykker kjøp. Vil du bytte navn,
er det én miljøvariabel: `BRAND_NAME`.

### 3. Opprett Fly.io-konto
```
# installer flyctl: https://fly.io/docs/flyctl/install/
flyctl auth signup
```
Krever betalingskort. Endre `app`-navnet øverst i `fly.toml` til noe globalt
unikt.

### 4. Sett opp Resend (e-post)
1. Opprett konto på resend.com — gratisplanen holder lenge (3 000 e-post/mnd,
   100 per døgn).
2. Legg til domenet ditt under «Domains».
3. Legg inn DNS-postene de oppgir (SPF, DKIM, og gjerne DMARC) hos
   domeneleverandøren. Verifisering tar 5–60 minutter.
4. Lag en API-nøkkel. Noter den.

**Hopper du over DNS-oppsettet, blir all e-post avvist.** Det er den vanligste
måten å ødelegge dette produktet på.

### 5. Sett opp Stripe
1. Opprett konto på stripe.com. Fyll ut foretaksopplysninger — utbetaling
   krever norsk organisasjonsnummer og bankkonto.
2. **Bli i testmodus foreløpig.**
3. Lag to produkter med månedlig gjentakende pris i **NOK**:
   - `Registervakt Solo` — 249 kr/mnd
   - `Registervakt Byrå` — 749 kr/mnd
4. Noter de to pris-ID-ene (`price_…`).
5. Hent testnøkkelen (`sk_test_…`).
6. Webhooken settes opp i steg 8, når du vet URL-en.

### 6. Lag .env
```
cp .env.example .env
```
Fyll inn alt. Lag `ADMIN_TOKEN` slik:
```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```
Sett `ALERT_EMAIL` til din egen adresse. Sett `BASE_URL` til domenet ditt med
`https://`.

### 7. Deploy
```
./deploy.sh
```
Skriptet kjører testene, oppretter app og volum, legger inn hemmelighetene fra
`.env` og deployer. Det er idempotent — kjør det gjerne om igjen.

### 8. Koble domenet til, og sett opp Stripe-webhooken
```
flyctl certs add dittdomene.no --app registervakt
```
Følg DNS-instruksjonen den gir. Når `https://dittdomene.no` svarer:

1. Stripe → Developers → Webhooks → Add endpoint
2. URL: `https://dittdomene.no/stripe/webhook`
3. Velg hendelsene: `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`,
   `invoice.payment_succeeded`
4. Kopier signeringshemmeligheten (`whsec_…`) inn i `.env`
5. `./deploy.sh` på nytt

### 9. Kjør doctor mot produksjon
```
flyctl ssh console --app registervakt --command "node scripts/doctor.js"
```
Nå skal alt være grønt, bortsett fra advarselen om at Stripe står i testmodus.

### 10. Gå gjennom hele kjøpsløpet selv
1. Åpne forsiden, velg Solo, skriv inn din egen e-post.
2. Betal med testkortet `4242 4242 4242 4242`, hvilken som helst fremtidig
   utløpsdato og CVC.
3. Sjekk at velkomstbrevet kommer, og at innloggingslenken virker.
4. Legg inn noen ekte organisasjonsnumre.
5. Åpne betalingsportalen fra Innstillinger og bekreft at du kan si opp selv.

**Kommer du gjennom dette uten å gjøre noe manuelt, er onboardingen automatisk.**

### 11. Bytt til ekte penger
Skru på live-modus i Stripe, lag de samme to prisene på nytt der, lag en ny
webhook mot samme URL, og bytt ut `sk_test_…`/`whsec_…`/`price_…` i `.env`
med live-verdiene. `./deploy.sh`.

### 12. Sett opp ekstern oppetidsovervåking
Registervakt varsler deg om sine egne feil, men kan ikke varsle om at den er
død. Legg inn en gratis sjekk mot `https://dittdomene.no/healthz` hos
UptimeRobot, Better Stack eller Fly sin egen varsling. Sett den til å varsle
ved noe annet enn HTTP 200.

**Dette er ikke valgfritt.** Uten det er hele varslingskjeden avhengig av at
maskinen som er nede, forteller deg at den er nede.

### 13. Vurder juridisk gjennomgang
`/vilkar` og `/personvern` er skrevet nøkternt og bevisst avgrenset — vi gjør
ikke kredittvurdering, og lagrer ingen personopplysninger om styremedlemmer
eller daglig leder. Det holder produktet utenfor konsesjonspliktig
kredittopplysningsvirksomhet. Skal du selge til regnskapsbyråer og inkasso, er
det likevel verdt en times gjennomgang hos advokat. Jeg er ikke jurist, og
dette er ikke juridisk rådgivning.

### 14. Skaff den første kunden
Dette er den vanskeligste delen, og det eneste jeg ikke har bygget noe for.
Se «Realistisk vurdering» nedenfor.

---

## 2. Faste månedskostnader

| Post | Kr/mnd | Merknad |
|---|---:|---|
| Fly.io — én maskin, shared-cpu-1x, 512 MB, alltid på | ~35 | Maskinen kan ikke sove; pollingen kjører i prosessen |
| Fly.io — 1 GB volum | ~2 | Holder i mange år på dette volumet |
| Fly.io — trafikk | ~1 | Produktet sender e-post, ikke video |
| Resend | 0 | Gratis opp til 3 000 e-post/mnd. Over det: ca. 210 kr/mnd |
| Domene `.no` | ~18 | 150–250 kr/år |
| **Sum faste kostnader** | **~55 kr/mnd** | |

**Variable kostnader:** Stripe tar ca. 1,4 % + 2 kr per transaksjon for
europeiske kort. På en Solo-kunde til 249 kr er det rundt 5,50 kr.

Kostnadene er praktisk talt uavhengige av antall kunder. Det er hele poenget
med arkitekturen: den globale endringsstrømmen fra Brreg hentes **én gang**
per runde uansett om du har 1 eller 500 kunder. Testen
`kostnaden skalerer med endringer, ikke med antall kunder` verifiserer det:
50 kunder som følger samme selskap gir maks tre kall mot Brreg.

Første reelle kostnadsøkning kommer når e-postvolumet passerer Resends
gratisgrense. Det skjer et sted rundt 100–200 aktive kunder.

---

## 3. Break-even

**Ren kontantmessig break-even: 1 kunde.**
Én Solo-kunde til 249 kr dekker de faste kostnadene på ~55 kr fire ganger om.
Selv gratisplanen alene koster deg ikke mer enn de 55 kronene.

**Det er ikke det tallet som betyr noe.** Regner du din egen tid som en
kostnad — og det bør du — ser det slik ut:

| Din timepris | Vedlikehold 2 t/mnd | Kunder for å gå i null |
|---:|---:|---:|
| 400 kr | 800 kr | **4 Solo-kunder** |
| 800 kr | 1 600 kr | **7 Solo-kunder** |
| 1 200 kr | 2 400 kr | **10 Solo-kunder** |

**Bruk 5–8 betalende kunder som det reelle break-even-tallet.** Under det
driver du et prosjekt, ikke en inntektskilde.

Til sammenlikning: 20 Solo-kunder er ca. 4 980 kr/mnd i omsetning og rundt
59 000 kr i året, med tilnærmet uendret arbeidsmengde. Det er det realistiske
taket for et produkt som dette uten aktivt salg.

---

## 4. Vedlikehold — realistisk anslag

| Situasjon | Timer per måned |
|---|---:|
| Ingen kunder ennå | **0,25** — kikke på at du ikke har fått varsler |
| 1–10 kunder | **1–2** — noen e-poster, en faktura-spørsmål eller to |
| 10–50 kunder | **2–4** — mer support, av og til en funksjonsforespørsel |
| Måned der Brreg endrer noe | **+4–6** engangs |
| Kvartalsvis avhengighetsoppdatering | **+1** hvert tredje måned |

**Regn med 1–3 timer i måneden i stabil drift**, med enkeltmåneder på 6–8 timer.

Det som holder tallet nede:
- To avhengigheter totalt (`stripe`, `better-sqlite3`). Ingen rammeverk, ingen
  byggesteg, ingen frontend-verktøykjede som råtner.
- Én datakilde, drevet av en statlig etat, med dokumentert delta-strøm.
- Kunden ordner selv oppsigelse, kortbytte og kvitteringer i Stripes portal.
- Ingen brukergenerert innhold, ingen moderering, ingen filopplasting.
- Systemet varsler deg kun ved faktiske feil, med to timers nedkjøling per
  feiltype.

Det som kan dra tallet opp: kunder som vil ha integrasjon mot regnskapssystemet
sitt. Si nei til de første ti som spør. Sier du ja, har du ikke lenger et
mikroprodukt.

---

## 5. De tre mest sannsynlige grunnene til at dette feiler

### 1. Ingen kjøper — fordi ingen vet at det finnes
**Dette er den klart mest sannsynlige utgangen.** Produktet er ferdig;
distribusjonen finnes ikke. Et norsk B2B-mikroprodukt uten publikum, uten
e-postliste og uten salgsinnsats får typisk null kunder, uansett hvor godt det
er bygget. Jeg har bygget tingen som løser problemet. Jeg har ikke bygget noen
grunn til at noen skal oppdage den.

Konkret: du må sannsynligvis sende 50–100 personlige e-poster til
regnskapsbyråer og inkassoselskaper for å få de første fem kundene. Det er
noen dagers arbeid, og det er ikke automatiserbart. Gjør du ikke det, skjer det
ingenting.

### 2. Fortrinnet er en pakketeringsvalg, og kan kopieres på et kvartal
Hele forskjellen på Registervakt og Proff Forvalt er at vi har pris på nettsiden
og de ikke har det. Det er ikke teknologi. Enhver av de seks aktørene i
VALIDATION.md kan lage en selvbetjent 249-kroners plan når som helst, og de har
allerede kunderelasjonen hos målgruppen.

Verre: Brønnøysundregistrene innførte i mai 2026 automatisk varsling til
personer som fjernes fra roller. Det er et smalt, lovpålagt tiltak — men det
viser at etaten beveger seg inn i varslingsrommet. Lanserer de gratis
vaktlister for organisasjonsnumre, forsvinner eksistensgrunnlaget over natten.

### 3. Stille deteksjonssvikt
Dette er den farligste feilen, fordi den ikke ser ut som en feil. Brreg endrer
et feltnavn, adapteren slutter å plukke opp konkursflagget, `/healthz` er
fortsatt grønn fordi pollingen kjører fint — og kundene får ingen varsler uten
at noen oppdager det. For et overvåkingsprodukt er dette dødelig: kunden
oppdager det først den dagen de mister penger på en konkurs de skulle ha visst
om, og da mister du ikke bare den kunden.

Delvis dempet av at `doctor.js` sjekker hvert eneste feltnavn eksplisitt. Men
den kjører bare når du kjører den. **Sett den i kalenderen én gang i kvartalet.**
Vil du gjøre én forbedring etter lansering, la det være å kjøre doctor
automatisk hver uke og varsle ved avvik.

---

## 6. Hva jeg bevisst ikke bygde

- **Kredittscoring og regnskapstall.** Konsesjonspliktig, og en helt annen
  forretning. Det er også salgsargumentet: vi er billige nettopp fordi vi ikke
  er det.
- **Overvåking av styremedlemmer og daglig leder.** Personopplysninger vi ikke
  trenger. Å ikke lagre dem er den enkleste GDPR-strategien som finnes.
- **Underenheter.** API-et støtter det, koden er forberedt på det, men det er
  ikke koblet på. Legger en kunde inn et underenhetsnummer, får de beskjed om
  at det ikke ble funnet.
- **Integrasjon mot Tripletex, PowerOffice, Visma.** Det er der
  konkurrentene er, og det er der vedlikeholdet er. Fire integrasjoner er fire
  API-er som ryker uavhengig av hverandre.
- **Selvbetjent oppgradering mellom Solo og Byrå i grensesnittet.** Kunden gjør
  det i Stripe-portalen; webhooken oppdaterer planen automatisk.

---

## 7. Hvis du vil legge ned

1. Si opp alle abonnementer i Stripe med refusjon av ubrukt tid.
2. Send én e-post til alle kunder — `/admin/eksport?token=…` gir deg listen.
3. `flyctl apps destroy registervakt`
4. Si opp domenet.

Ingen kunde blir sittende med data de ikke får ut: alt de har lagt inn er
organisasjonsnumre de allerede har i sitt eget system.
