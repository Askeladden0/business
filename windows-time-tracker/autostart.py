"""Registrerer/fjerner autostart av appen ved Windows-pålogging.

Metode: snarvei i brukerens oppstartsmappe (shell:startup), IKKE
registry Run-nøkkel.

Hvorfor snarvei i oppstartsmappen fremfor registry:
- Krever ingen admin-rettigheter (skrives kun til brukerens egen profil).
- Synlig og lett å inspisere/fjerne for brukeren (åpne shell:startup i
  Explorer og slette filen), i motsetning til en registry-nøkkel.
- Windows Defender/antivirus flagger registry Run-endringer oftere som
  mistenkelig; en vanlig .lnk i oppstartsmappen er standard og forventet.
- PyInstaller-exe-en kan pekes på direkte fra snarveien, uten avhengighet
  av at Python er installert.
"""
import logging
import os
import sys

logger = logging.getLogger(__name__)

SHORTCUT_NAME = "WindowsTimeTracker.lnk"


def _startup_folder() -> str:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("Fant ikke %APPDATA% - er dette Windows?")
    return os.path.join(appdata, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")


def _target_path() -> str:
    if getattr(sys, "frozen", False):
        return sys.executable
    return os.path.abspath(sys.argv[0])


def is_registered() -> bool:
    shortcut_path = os.path.join(_startup_folder(), SHORTCUT_NAME)
    return os.path.exists(shortcut_path)


def register():
    """Oppretter snarvei i oppstartsmappen som peker på exe/scriptet."""
    import win32com.client  # pywin32, kun tilgjengelig på Windows

    shortcut_path = os.path.join(_startup_folder(), SHORTCUT_NAME)
    target = _target_path()

    shell = win32com.client.Dispatch("WScript.Shell")
    shortcut = shell.CreateShortCut(shortcut_path)
    shortcut.Targetpath = target
    shortcut.WorkingDirectory = os.path.dirname(target)
    shortcut.IconLocation = target
    shortcut.Description = "Windows Time Tracker"
    shortcut.save()
    logger.info("Autostart registrert: %s -> %s", shortcut_path, target)


def unregister():
    """Fjerner snarveien fra oppstartsmappen (no-op hvis den ikke finnes)."""
    shortcut_path = os.path.join(_startup_folder(), SHORTCUT_NAME)
    if os.path.exists(shortcut_path):
        os.remove(shortcut_path)
        logger.info("Autostart fjernet: %s", shortcut_path)


if __name__ == "__main__":
    if not is_registered():
        register()
        print("Autostart registrert.")
    else:
        print("Autostart er allerede registrert.")
