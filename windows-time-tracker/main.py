"""Inngangspunkt for Windows Time Tracker.

Flyt:
1. Registrerer autostart (snarvei i oppstartsmappen) hvis aktivert i config.
2. Viser "Start arbeidsøkt?"-popup.
3. Starter systemkurv-ikonet (blokkerer hovedtråden - Windows krever at
   ikon-meldingsløkken kjører i tråden som opprettet den).
4. Hvis brukeren svarte Ja, startes økten i tray-oppsettet.
"""
import logging
import os
import sys

from config import AUTOSTART_ENABLED, BASE_DIR, DATABASE_PATH
from database import Database
from popup import ask_start_session, show_break_reminder
from tracker import TimeTracker

LOG_PATH = os.path.join(BASE_DIR, "timetracker.log")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("main")


def _try_register_autostart():
    if not AUTOSTART_ENABLED:
        return
    try:
        import autostart
        if not autostart.is_registered():
            autostart.register()
    except Exception:
        logger.exception("Kunne ikke registrere autostart (fortsetter uten)")


def main():
    logger.info("Starter Windows Time Tracker (db: %s)", DATABASE_PATH)
    _try_register_autostart()

    db = Database()

    def on_break_reminder():
        from config import POMODORO_BREAK_MINUTES
        show_break_reminder(POMODORO_BREAK_MINUTES)

    tracker = TimeTracker(db, on_break_reminder=on_break_reminder)

    # Lazy import for å unngå at pystray/PIL kreves for å kjøre
    # bakgrunnssporingen alene (nyttig under tidlig utvikling/test).
    from dashboard import open_dashboard
    from tray import TrayApp

    def open_dashboard_callback():
        open_dashboard(db)

    def on_quit():
        db.close()
        os._exit(0)

    tray_app = TrayApp(tracker, open_dashboard_callback, on_quit)
    tracker.on_status_change = tray_app.on_status_change

    should_start = ask_start_session()
    if should_start:
        tracker.start_session()

    tray_app.run()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logger.exception("Uventet feil - appen avsluttes")
        raise
