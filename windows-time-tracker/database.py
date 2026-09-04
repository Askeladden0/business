"""SQLite-lagring for arbeidsøkter og app-bruk."""
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime

from config import DATABASE_PATH

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_time TEXT NOT NULL,
    end_time TEXT,
    active_seconds INTEGER NOT NULL DEFAULT 0,
    idle_seconds INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    app_name TEXT NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    UNIQUE(session_id, app_name)
);

CREATE INDEX IF NOT EXISTS idx_app_usage_session ON app_usage(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start_time);
"""


class Database:
    """Trådsikker enkel wrapper rundt SQLite-databasen.

    Bruker en lock siden trackeren skriver fra en bakgrunnstråd mens
    dashboardet kan lese fra hovedtråden samtidig.
    """

    def __init__(self, path: str = DATABASE_PATH):
        self.path = path
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    @contextmanager
    def _cursor(self):
        with self._lock:
            cur = self._conn.cursor()
            try:
                yield cur
                self._conn.commit()
            finally:
                cur.close()

    # --- Økter -----------------------------------------------------
    def start_session(self) -> int:
        with self._cursor() as cur:
            cur.execute(
                "INSERT INTO sessions (start_time, active_seconds, idle_seconds) "
                "VALUES (?, 0, 0)",
                (datetime.now().isoformat(timespec="seconds"),),
            )
            return cur.lastrowid

    def end_session(self, session_id: int, active_seconds: int, idle_seconds: int):
        with self._cursor() as cur:
            cur.execute(
                "UPDATE sessions SET end_time = ?, active_seconds = ?, "
                "idle_seconds = ? WHERE id = ?",
                (
                    datetime.now().isoformat(timespec="seconds"),
                    active_seconds,
                    idle_seconds,
                    session_id,
                ),
            )

    def update_session_totals(self, session_id: int, active_seconds: int, idle_seconds: int):
        with self._cursor() as cur:
            cur.execute(
                "UPDATE sessions SET active_seconds = ?, idle_seconds = ? WHERE id = ?",
                (active_seconds, idle_seconds, session_id),
            )

    def get_open_session(self):
        """Finner en økt uten end_time, f.eks. etter et krasj/dvale."""
        with self._cursor() as cur:
            cur.execute(
                "SELECT id FROM sessions WHERE end_time IS NULL "
                "ORDER BY id DESC LIMIT 1"
            )
            row = cur.fetchone()
            return row[0] if row else None

    def close_stale_sessions(self):
        """Lukker økter som ble stående åpne pga. krasj/dvale ved forrige kjøring."""
        with self._cursor() as cur:
            cur.execute(
                "UPDATE sessions SET end_time = start_time "
                "WHERE end_time IS NULL"
            )

    # --- App-bruk ----------------------------------------------------
    def record_app_usage(self, session_id: int, app_name: str, seconds: int):
        now = datetime.now().isoformat(timespec="seconds")
        with self._cursor() as cur:
            cur.execute(
                "SELECT id FROM app_usage WHERE session_id = ? AND app_name = ?",
                (session_id, app_name),
            )
            row = cur.fetchone()
            if row:
                cur.execute(
                    "UPDATE app_usage SET seconds = seconds + ?, last_seen = ? "
                    "WHERE id = ?",
                    (seconds, now, row[0]),
                )
            else:
                cur.execute(
                    "INSERT INTO app_usage (session_id, app_name, seconds, "
                    "first_seen, last_seen) VALUES (?, ?, ?, ?, ?)",
                    (session_id, app_name, seconds, now, now),
                )

    # --- Rapportering ------------------------------------------------
    def total_active_seconds_between(self, start_iso: str, end_iso: str) -> int:
        with self._cursor() as cur:
            cur.execute(
                "SELECT COALESCE(SUM(active_seconds), 0) FROM sessions "
                "WHERE start_time >= ? AND start_time < ?",
                (start_iso, end_iso),
            )
            return cur.fetchone()[0]

    def app_usage_between(self, start_iso: str, end_iso: str):
        """Returnerer [(app_name, total_seconds), ...] sortert synkende."""
        with self._cursor() as cur:
            cur.execute(
                "SELECT au.app_name, SUM(au.seconds) FROM app_usage au "
                "JOIN sessions s ON s.id = au.session_id "
                "WHERE s.start_time >= ? AND s.start_time < ? "
                "GROUP BY au.app_name ORDER BY SUM(au.seconds) DESC",
                (start_iso, end_iso),
            )
            return cur.fetchall()

    def close(self):
        self._conn.close()
