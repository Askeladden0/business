"""Systemkurv-ikon (pystray) med statusfarge og høyreklikk-meny."""
import logging
import threading

from PIL import Image, ImageDraw
from pystray import Icon, Menu, MenuItem

from tracker import SessionStatus

logger = logging.getLogger(__name__)

_STATUS_COLORS = {
    SessionStatus.STOPPED: (150, 150, 150),   # grå = stoppet
    SessionStatus.ACTIVE: (46, 204, 113),     # grønn = aktiv
    SessionStatus.IDLE: (241, 196, 15),       # gul = idle/pause
}


def _make_icon_image(color) -> Image.Image:
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    margin = 6
    draw.ellipse((margin, margin, size - margin, size - margin), fill=color)
    return img


class TrayApp:
    """Kobler sammen TimeTracker, dashboard og systemkurv-ikonet."""

    def __init__(self, tracker, open_dashboard_callback, on_quit_callback):
        self.tracker = tracker
        self.open_dashboard_callback = open_dashboard_callback
        self.on_quit_callback = on_quit_callback

        self.icon = Icon(
            "windows-time-tracker",
            _make_icon_image(_STATUS_COLORS[SessionStatus.STOPPED]),
            "Tidssporing (stoppet)",
            menu=self._build_menu(),
        )

    def _build_menu(self) -> Menu:
        return Menu(
            MenuItem(self._toggle_label, self._on_toggle_session),
            MenuItem("Åpne dashboard", self._on_open_dashboard),
            Menu.SEPARATOR,
            MenuItem("Avslutt", self._on_quit),
        )

    def _toggle_label(self, _item=None) -> str:
        return "Stopp økt" if self.tracker.is_running else "Start økt"

    def _on_toggle_session(self, icon=None, item=None):
        if self.tracker.is_running:
            self.tracker.stop_session()
        else:
            self.tracker.start_session()
        self.icon.update_menu()

    def _on_open_dashboard(self, icon=None, item=None):
        try:
            self.open_dashboard_callback()
        except Exception:
            logger.exception("Kunne ikke åpne dashboard")

    def _on_quit(self, icon=None, item=None):
        try:
            if self.tracker.is_running:
                self.tracker.stop_session()
        finally:
            self.icon.stop()
            if self.on_quit_callback:
                self.on_quit_callback()

    def on_status_change(self, status: SessionStatus):
        color = _STATUS_COLORS.get(status, _STATUS_COLORS[SessionStatus.STOPPED])
        labels = {
            SessionStatus.STOPPED: "Tidssporing (stoppet)",
            SessionStatus.ACTIVE: "Tidssporing (aktiv)",
            SessionStatus.IDLE: "Tidssporing (idle/pause)",
        }
        self.icon.icon = _make_icon_image(color)
        self.icon.title = labels.get(status, "Tidssporing")
        self.icon.update_menu()

    def run(self):
        """Blokkerende - må kalles fra hovedtråden."""
        self.icon.run()

    def run_detached(self):
        thread = threading.Thread(target=self.icon.run, daemon=True)
        thread.start()
        return thread
