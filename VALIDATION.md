# Fase 2 — Valideringsrapport

**Produkt:** Registervakt — endringsvarsling på Enhetsregisteret
**Dato for undersøkelse:** 31. august 2026
**Konklusjon:** Gå videre. Nisjen er verken død eller mettet, men den er
omstridt. Se «Ærlig oppsummering» nederst.

---

## 1. Datakilden holder

Brønnøysundregistrene publiserer Enhetsregisteret som åpne data med et
dokumentert REST-API på `https://data.brreg.no/enhetsregisteret/api`.

- Endepunktene `/oppdateringer/enheter` og `/oppdateringer/underenheter` ble
  innført i API-versjon 1.1.0 og er laget nettopp for dette bruksmønsteret:
  hent hvilke enheter som er endret, slå så opp de enkelte enhetene som faktisk
  har endret seg.
- Data oppdateres én gang i døgnet; filene produseres hver natt rundt 05:00.
- Paginering med `page` + `size`, med begrensningen at `(page+1)*size` ikke kan
  overstige 10 000.
- Lisens: NLOD / åpne data. Ingen API-nøkkel, ingen kostnad, ingen kvote som
  krever avtale.

Dette gir en gratis, stabil, myndighetsdrevet datakilde. Det er den enkeltvis
viktigste grunnen til at vedlikeholdsbyrden blir lav: det finnes ingen HTML å
scrape og ingen selektorer som ryker.

> **Uverifisert i denne økten:** sesjonens egress-proxy blokkerer
> `data.brreg.no`, så jeg har ikke kunnet kalle API-et live. Feltnavn og
> responsformer er utledet fra dokumentasjonen, ikke bekreftet mot en levende
> respons. Adapteren er derfor skrevet defensivt (flere kandidatnøkler per
> felt), og `npm run doctor` verifiserer alle antakelser mot det ekte API-et på
> ett kall. Dette er punkt 1 på sjekklisten i HANDOVER.md.

## 2. Etterspørselen finnes

Signaler funnet:

- **Regnskapsbyråene har et regulatorisk drevet behov for porteføljeoversikt.**
  Finanstilsynets veiledning om hvitvaskingsregelverket krever at byråene
  identifiserer kunder med forhøyet risiko og holder løpende oversikt over
  risikoen i kundeporteføljen. Registerendringer (eierskifte, adresseendring,
  tvangsavvikling) er direkte input til den vurderingen.
- **Det finnes allerede produkter som selger nøyaktig denne varslingen** —
  se konkurrentlisten under. Eksisterende betalende marked er et sterkere
  signal enn fravær av konkurrenter.
- **Konkursbølgen gir kjøpsutløser.** Leverandører til norske SMB-er taper
  penger når kunder går konkurs, og verdien av å få vite det ved
  tvangsavviklingsvedtak — ikke ved sluttoppgjøret — er lett å regne på.

## 3. Konkurrenter og prisnivå

| Aktør | Hva de gjør | Pris | Salgsform |
|---|---|---|---|
| **Proff Forvalt** | Overvåking + konkursvarsling per e-post, bundlet med kredittsjekk, betalingsanmerkninger og konkursrating (AUC 0,90) | Ikke offentlig | Salgsstyrt |
| **Creditsafe** | Overvåking av foretak i Norge, Europa og USA | Ikke offentlig | Salgsstyrt |
| **Dun & Bradstreet / Bisnode** | Kredittinformasjon med overvåking | Ikke offentlig | Enterprise |
| **regnskapstall.no** | Varsler når det offentlige gjør endringer som gjelder dine kunder eller konkurrenter | Ikke offentlig | Salgsstyrt |
| **konkursvarsel.io** | Konkursvarsling koblet til kundereskontro; integrasjoner mot Tripletex, PowerOffice GO, Visma Business NXT, Visma.net | Ikke offentlig på forsiden | Selvbetjent/integrasjon |
| **Emonkey Konkursradar** | Konkursvarsling for kunder og leverandører | Ikke offentlig | Salgsstyrt |

**Det avgjørende funnet:** ingen av dem oppgir pris offentlig. Alle krever
kontaktskjema eller integrasjon mot et regnskapssystem. Det betyr at en kunde
som bare vil legge inn 40 organisasjonsnumre og få e-post når noe skjer, må
gjennom en salgsprosess for å kjøpe noe som burde tatt to minutter.

## 4. Hvor Registervakt skiller seg

1. **Transparent pris, ingen salgssamtale.** Kortet inn, i gang på to minutter.
2. **Alle registerendringer, ikke bare konkurs.** Navn, organisasjonsform,
   adresse, næringskode, MVA-registrering, antall ansatte, avvikling, sletting.
   konkursvarsel.io og Konkursradar dekker konkurs-skiven alene.
3. **Ingen kredittscoring.** Det er bevisst: kredittopplysningsvirksomhet i
   Norge er konsesjonspliktig. Registervakt videreformidler faktiske,
   offentlige registerhendelser og beregner ingen score. Det holder produktet
   utenfor regulert område og fjerner hele klassen av juridisk risiko.
4. **Krever ikke regnskapssystem.** CSV-import, manuell innlegging eller API.
   konkursvarsel.io er avhengig av at du bruker ett av fire regnskapssystemer.
5. **Ingen personopplysninger om roller.** Vi sporer bevisst ikke styremedlemmer
   eller daglig leder. Det reduserer GDPR-flaten til kundens egen e-postadresse.

## 5. Markedsstørrelse — nøkternt

- Ca. 1,1 millioner enheter i Enhetsregisteret, ca. 350 000 aktive aksjeselskap.
- Realistisk kjøpergruppe: regnskapsbyråer (ca. 1 800 autoriserte foretak),
  inkassoselskap, B2B-leverandører med kundereskontro av en viss størrelse,
  forsikringsmeglere, utleiere av næringseiendom.
- Jeg anslår **et par tusen norske virksomheter** som plausible kjøpere til
  249–749 kr/mnd. Det er ikke et stort marked. Det er et marked som tåler et
  mikroprodukt med to prisplaner og null ansatte, og ikke stort mer.

## 6. Risikoer funnet i valideringen

1. **Brreg kan selv bygge varsling.** De innførte i mai 2026 automatisk
   varsling til personer som fjernes fra roller som styremedlem eller daglig
   leder. Det er et smalt, lovpålagt tiltak mot selskapstyveri, ikke et
   porteføljeovervåkingsprodukt — men det viser at etaten beveger seg inn i
   varslingsrommet. Hvis de lanserer gratis vaktlister for organisasjonsnumre,
   forsvinner produktets eksistensgrunnlag.
2. **Konkurrentene kan senke prisen og bli selvbetjente.** Wedgen er
   forretningsmodell, ikke teknologi. Den kan kopieres på et kvartal.
3. **Datakilden er én dags forsinket.** Brreg oppdaterer nattlig. Vi kan aldri
   love sanntid, og markedsføringen må ikke antyde det.

## Ærlig oppsummering

Nisjen er **ikke død** (flere aktører tjener penger på den) og **ikke mettet**
(ingen av dem selger selvbetjent til transparent pris). Men den er heller ikke
åpen mark: seks aktører er identifisert, hvorav minst to er godt finansierte
kredittopplysningsbyråer som allerede har kunderelasjonen hos målgruppen.

Vurderingen er at et selvbetjent produkt til 249 kr/mnd kan ta den delen av
markedet som i dag ikke kjøper i det hele tatt fordi terskelen er en
salgssamtale. Det er en reell, men beskjeden mulighet — anslagsvis titalls
kunder, ikke hundrevis, i det første året. Se HANDOVER.md for break-even og
de tre mest sannsynlige feilmodusene.

## Kilder

- https://data.brreg.no/enhetsregisteret/api/dokumentasjon/no/index.html
- https://data.norge.no/en/datasets/68d08f28-a16d-4fab-a953-ed4ab08ce2e2/central-coordinating-register-for-legal-entities
- https://www.brreg.no/en/use-of-data-from-the-bronnoysund-register-centre/subscription/
- https://www.revisorforeningen.no/fag/nyheter/bronnoysundregistrene-innforer-automatisk-varsling
- https://forvalt.no/Landingssider/konkursvarsling-e-post
- https://www.creditsafe.com/no/no/kreditt-risiko/risikoverktoy/overvaking.html
- https://info.regnskapstall.no/overvaking
- https://konkursvarsel.io/
- https://www.emonkey.no/tjenester/konkursradar
- https://www.finanstilsynet.no/nyhetsarkiv/rundskriv/2019/veiledning-om-regnskapsforeres-og-regnskapsforerselskapers-etterlevelse-av-hvitvaskingsregelverket/
