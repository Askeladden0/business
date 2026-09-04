"""Bakgrunnssporing av aktivt vindu, idle-tid og pomodoro-varsler.

Kjører i egen tråd. Sjekker aktivt vindu/prosess hvert sekund (styrt av
config.poll_interval_seconds), og setter økten i "idle" hvis ingen
mus/tastatur-aktivitet er registrert på idle_threshold_seconds.
"""
import ctypes
import logging
import threading
import time
from datetime import datetime
from enum import Enum
from typing import Callable, Optional

import psutil

try:
    import win32gui
    import win32process
    WINDOWS = True
except ImportError:  # tillater import/test på ikke-Windows for utvikling
    WINDOWS = False

from config import IDLE_THRESHOLD_SECONDS, POLL_INTERVAL_SECONDS, POMODORO_ENABLED
from database import Database
from pomodoro import PomodoroTimer

logger = logging.getLogger(__name__)


class SessionStatus(Enum):
    STOPPED = "stopped"
    ACTIVE = "active"
    IDLE = "idle"


class _LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]


def get_idle_seconds() -> float:
    """Sekunder siden siste mus-/tastaturaktivitet, via Windows API."""
    if not WINDOWS:
        return 0.0
    info = _LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(_LASTINPUTINFO)
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
        return 0.0
    millis_since_boot = ctypes.windll.kernel32.GetTickCount()
    return max(0.0, (millis_since_boot - info.dwTime) / 1000.0)


def get_active_app_name() -> Optional[str]:
    """Prosessnavn (f.eks. 'chrome.exe') for det aktive vinduet.

    Returnerer None hvis det aktive vinduet ikke kan identifiseres i
    stedet for å kaste feil - appen skal aldri krasje pga. dette.
    """
    if not WINDOWS:
        return None
    try:
        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        if not pid:
            return None
        process = psutil.Process(pid)
        return process.name()
    except (psutil.NoSuchProcess, psutil.AccessDenied, Exception) as exc:
        logger.debug("Kunne ikke identifisere aktivt vindu: %s", exc)
        return None


class TimeTracker:
    """Sporer aktiv tid per app for én arbeidsøkt om gangen.

    Kalles fra tray/GUI-lag via start_session()/stop_session(). Kjører sin
    egen pollingstråd, og sender statusendringer videre via on_status_change
    slik at f.eks. tray-ikonet kan oppdatere seg.
    """

    def __init__(
        self,
        db: Database,
        on_status_change: Optional[Callable[[SessionStatus], None]] = None,
        on_break_reminder: Optional[Callable[[], None]] = None,
    ):
        self.db = db
        self.on_status_change = on_status_change
        self.on_break_reminder = on_break_reminder

        self.status = SessionStatus.STOPPED
        self._session_id: Optional[int] = None
        self._active_seconds = 0
        self._idle_seconds = 0
        self._current_app: Optional[str] = None
        self._current_app_seconds = 0

        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

        self.pomodoro = PomodoroTimer(on_break_due=self._handle_break_due) \
            if POMODORO_ENABLED else None

        # Rydd opp økter som ble hengende åpne pga. krasj/dvale forrige gang.
        self.db.close_stale_sessions()

    @property
    def is_running(self) -> bool:
        return self.status != SessionStatus.STOPPED

    def start_session(self):
        if self.is_running:
            return
        self._session_id = self.db.start_session()
        self._active_seconds = 0
        self._idle_seconds = 0
        self._current_app = None
        self._current_app_seconds = 0
        self._stop_event.clear()
        self._set_status(SessionStatus.ACTIVE)
        if self.pomodoro:
            self.pomodoro.reset()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        logger.info("Startet økt %s", self._session_id)

    def stop_session(self):
        if not self.is_running:
            return
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
        self._flush_current_app()
        try:
            self.db.end_session(self._session_id, self._active_seconds, self._idle_seconds)
        except Exception:
            logger.exception("Kunne ikke lukke økt %s pent", self._session_id)
        logger.info("Avsluttet økt %s (%ss aktiv, %ss idle)",
                    self._session_id, self._active_seconds, self._idle_seconds)
        self._session_id = None
        self._set_status(SessionStatus.STOPPED)

    def _set_status(self, status: SessionStatus):
        self.status = status
        if self.on_status_change:
            try:
                self.on_status_change(status)
            except Exception:
                logger.exception("Feil i on_status_change-callback")

    def _flush_current_app(self):
        if self._current_app and self._current_app_seconds > 0:
            try:
                self.db.record_app_usage(
                    self._session_id, self._current_app, self._current_app_seconds
                )
            except Exception:
                logger.exception("Kunne ikke lagre app-bruk")
        self._current_app = None
        self._current_app_seconds = 0

    def _handle_break_due(self):
        if self.on_break_reminder:
            try:
                self.on_break_reminder()
            except Exception:
                logger.exception("Feil i on_break_reminder-callback")

    def _run(self):
        last_flush = time.time()
        while not self._stop_event.is_set():
            try:
                idle_secs = get_idle_seconds()
                is_idle = idle_secs >= IDLE_THRESHOLD_SECONDS

                if is_idle:
                    if self.status != SessionStatus.IDLE:
                        self._flush_current_app()
                        self._set_status(SessionStatus.IDLE)
                        if self.pomodoro:
                            self.pomodoro.pause()
                    self._idle_seconds += POLL_INTERVAL_SECONDS
                else:
                    if self.status != SessionStatus.ACTIVE:
                        self._set_status(SessionStatus.ACTIVE)
                        if self.pomodoro:
                            self.pomodoro.resume()
                    self._active_seconds += POLL_INTERVAL_SECONDS

                    app_name = get_active_app_name() or "Ukjent"
                    if app_name != self._current_app:
                        self._flush_current_app()
                        self._current_app = app_name
                        self._current_app_seconds = 0
                    self._current_app_seconds += POLL_INTERVAL_SECONDS

                    if self.pomodoro:
                        self.pomodoro.tick(POLL_INTERVAL_SECONDS)

                # Skriv jevnlig til disk slik at data ikke går tapt ved
                # krasj eller at PCen går i dvale midt i en økt.
                if time.time() - last_flush >= 10:
                    self._flush_current_app()
                    self.db.update_session_totals(
                        self._session_id, self._active_seconds, self._idle_seconds
                    )
                    last_flush = time.time()

            except Exception:
                logger.exception("Uventet feil i sporingsløkken - fortsetter")

            self._stop_event.wait(POLL_INTERVAL_SECONDS)
