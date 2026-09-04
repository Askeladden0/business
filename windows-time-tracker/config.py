"""Laster og eksponerer konfigurasjon fra config.json.

Alle justerbare verdier (pomodoro-intervaller, idle-terskel, databasesti osv.)
skal ligge her og i config.json - ikke hardkodes andre steder i koden.
"""
import json
import os
import sys


def _base_dir() -> str:
    # Når appen er pakket med PyInstaller ligger config.json ved siden av
    # exe-filen (sys.executable), ellers ved siden av dette scriptet.
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = _base_dir()
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

_DEFAULTS = {
    "database_path": "data/timetracker.db",
    "poll_interval_seconds": 1,
    "idle_threshold_seconds": 300,
    "pomodoro": {
        "enabled": True,
        "work_minutes": 45,
        "break_minutes": 10,
    },
    "autostart": {
        "enabled": True,
    },
    "dashboard": {
        "default_period": "day",
    },
}


def _deep_merge(defaults: dict, overrides: dict) -> dict:
    result = dict(defaults)
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_config(path: str = CONFIG_PATH) -> dict:
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            user_config = json.load(f)
    else:
        user_config = {}
    return _deep_merge(_DEFAULTS, user_config)


CONFIG = load_config()

# Gjør databasestien absolutt relativt til prosjektmappen slik at appen
# fungerer uansett hvilken mappe den startes fra (f.eks. via autostart).
DATABASE_PATH = os.path.join(BASE_DIR, CONFIG["database_path"])
POLL_INTERVAL_SECONDS = CONFIG["poll_interval_seconds"]
IDLE_THRESHOLD_SECONDS = CONFIG["idle_threshold_seconds"]
POMODORO_ENABLED = CONFIG["pomodoro"]["enabled"]
POMODORO_WORK_MINUTES = CONFIG["pomodoro"]["work_minutes"]
POMODORO_BREAK_MINUTES = CONFIG["pomodoro"]["break_minutes"]
AUTOSTART_ENABLED = CONFIG["autostart"]["enabled"]
DASHBOARD_DEFAULT_PERIOD = CONFIG["dashboard"]["default_period"]
