# Windows Time Tracker

En liten Windows-skrivebordsapp i Python som sporer arbeidstid på PCen din:
hvilke apper du bruker, idle-deteksjon, pomodoro-pausepåminnelser og et
dashboard over tidsbruk.

## Funksjonalitet

- Oppstartspopup ("Start arbeidsøkt?") ved Windows-pålogging
- Sporer aktivt vindu/prosess hvert sekund og lagrer tid per app
- Setter økten på pause automatisk etter 5 minutter uten mus-/tastaturaktivitet
- Konfigurerbare pomodoro-pausepåminnelser (standard: 45 min jobb / 10 min pause)
- Systemkurv-ikon som viser status (grønn = aktiv, gul = idle, grå = stoppet),
  med meny for start/stopp av økt, åpne dashboard og avslutt
- SQLite-database lokalt (`data/timetracker.db`)
- Dashboard med total arbeidstid i dag/uke/måned/år og stolpediagram over
  tidsbruk per app, med navigasjon mellom perioder

## Prosjektstruktur

```
windows-time-tracker/
  main.py         Inngangspunkt - binder sammen popup, tracker og tray
  tracker.py       Bakgrunnssporing av aktivt vindu, idle-deteksjon, pomodoro-hook
  pomodoro.py      Pomodoro-timer (jobb/pause-intervaller)
  database.py      SQLite-lagring (økter og app-bruk)
  dashboard.py      Dashboard-vindu (tkinter + matplotlib)
  popup.py          Oppstarts- og pausepåminnelse-popups (tkinter)
  tray.py            Systemkurv-ikon (pystray)
  autostart.py       Registrerer/fjerner autostart via oppstartsmappen
  config.py           Laster config.json
  config.json           Alle justerbare verdier
  requirements.txt
  windows_time_tracker.spec   PyInstaller-spec
```

## Installasjon

Krever Python 3.10+ på Windows (pywin32 og GetLastInputInfo/win32gui er
Windows-spesifikke - appen kjører ikke funksjonelt på macOS/Linux).

```powershell
cd windows-time-tracker
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

## Kjøring (utvikling)

```powershell
python main.py
```

Første gang appen kjøres opprettes `data/timetracker.db` automatisk, og en
snarvei legges i oppstartsmappen (`shell:startup`) hvis `autostart.enabled`
er `true` i `config.json`.

Du kan også teste enkeltdeler isolert:

```powershell
python database.py   # verifiserer at databasen kan opprettes
python dashboard.py   # åpner dashboardet mot eksisterende data
```

## Konfigurasjon (`config.json`)

```json
{
  "database_path": "data/timetracker.db",
  "poll_interval_seconds": 1,
  "idle_threshold_seconds": 300,
  "pomodoro": {
    "enabled": true,
    "work_minutes": 45,
    "break_minutes": 10
  },
  "autostart": {
    "enabled": true
  },
  "dashboard": {
    "default_period": "day"
  }
}
```

Alle disse verdiene kan endres uten å røre koden. `database_path` er
relativ til mappen der `main.py`/`.exe` ligger.

## Autostart - valgt metode

Appen legger en `.lnk`-snarvei i brukerens oppstartsmappe
(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`), **ikke**
registry `Run`-nøkkelen. Begrunnelse:

- Krever ingen admin-rettigheter.
- Lett synlig og fjernbar for brukeren (bare slett filen i
  `shell:startup`), i motsetning til en skjult registry-verdi.
- Registry `Run`-endringer trigger oftere falske positiver i
  antivirus/Windows Defender enn en standard oppstartsmappe-snarvei.

Slå av med `"autostart": {"enabled": false}` i `config.json`, eller kjør
`python autostart.py` for å registrere manuelt / slett `.lnk`-filen fra
`shell:startup` for å fjerne.

## Pakking til .exe med PyInstaller

```powershell
pip install pyinstaller
pyinstaller windows_time_tracker.spec
```

Resultatet havner i `dist/WindowsTimeTracker/WindowsTimeTracker.exe`
(eller `dist/WindowsTimeTracker.exe` ved one-file build - se under).
`config.json` kopieres automatisk med i build-mappen (definert i
`.spec`-filen), og `data/`-mappen opprettes ved første kjøring av exe-en.

For en enkelt fil (`--onefile`) i stedet for en mappe:

```powershell
pyinstaller --onefile --windowed --name WindowsTimeTracker --add-data "config.json;." main.py
```

Etter bygging: kopier den resulterende exe-en dit du vil ha den permanent
liggende (f.eks. `C:\Program Files\WindowsTimeTracker\` eller en mappe
under brukerprofilen), siden autostart-snarveien peker på
`sys.executable` sin plassering ved oppstart.

## Feilhåndtering

- Hvis det aktive vinduet ikke kan identifiseres (f.eks. under en
  vindusovergang), logges det og appen fortsetter uten å krasje - tiden
  registreres da på "Ukjent".
- Går PCen i dvale/hibernate midt i en økt, blir økten stående uten
  `end_time` i databasen. Ved neste oppstart lukker appen automatisk slike
  hengende økter (`close_stale_sessions`) før en ny økt startes.
- Alle uventede feil i sporingsløkken fanges og logges til
  `timetracker.log` uten at appen avsluttes.

## Rekkefølgen appen ble bygget i

1. Grunnstruktur: `config.py`/`config.json`, `database.py` (skjema),
   `tracker.py` uten GUI - kun bakgrunnssporing.
2. Oppstartspopup (`popup.py`).
3. Systemkurv-ikon (`tray.py`) med statusfarger og meny.
4. Idle-deteksjon (`GetLastInputInfo` i `tracker.py`).
5. Pomodoro-pausepåminnelser (`pomodoro.py`).
6. Dashboard (`dashboard.py`).
7. Autostart (`autostart.py`) og PyInstaller-pakking.
