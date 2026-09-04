"""Dashboard: tkinter-vindu som viser arbeidstid og app-fordeling.

Viser total arbeidstid i dag/uke/måned/år og et stolpediagram over
tidsbruk per app, med navigasjon mellom perioder og enkel bla
bakover/fremover i tid.
"""
import calendar
import tkinter as tk
from datetime import datetime, timedelta
from tkinter import ttk

from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure

from database import Database
from popup import _tk_lock

PERIODS = ["day", "week", "month", "year"]
PERIOD_LABELS = {"day": "Dag", "week": "Uke", "month": "Måned", "year": "År"}


def _period_bounds(period: str, anchor: datetime):
    if period == "day":
        start = anchor.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
    elif period == "week":
        start = (anchor - timedelta(days=anchor.weekday())).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        end = start + timedelta(days=7)
    elif period == "month":
        start = anchor.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        last_day = calendar.monthrange(start.year, start.month)[1]
        end = start + timedelta(days=last_day)
    elif period == "year":
        start = anchor.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
        end = start.replace(year=start.year + 1)
    else:
        raise ValueError(f"Ukjent periode: {period}")
    return start, end


def _shift(period: str, anchor: datetime, direction: int) -> datetime:
    if period == "day":
        return anchor + timedelta(days=direction)
    if period == "week":
        return anchor + timedelta(weeks=direction)
    if period == "month":
        month = anchor.month - 1 + direction
        year = anchor.year + month // 12
        month = month % 12 + 1
        day = min(anchor.day, calendar.monthrange(year, month)[1])
        return anchor.replace(year=year, month=month, day=day)
    if period == "year":
        return anchor.replace(year=anchor.year + direction)
    raise ValueError(f"Ukjent periode: {period}")


def _format_hours(seconds: int) -> str:
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    return f"{hours}t {minutes}m"


class Dashboard:
    def __init__(self, db: Database):
        self.db = db
        self.period = "day"
        self.anchor = datetime.now()

        self.root = tk.Tk()
        self.root.title("Tidssporing - Dashboard")
        self.root.geometry("800x600")

        self._build_summary_row()
        self._build_period_controls()
        self._build_chart()
        self.refresh()

    def _build_summary_row(self):
        frame = ttk.Frame(self.root, padding=10)
        frame.pack(fill="x")

        self.summary_labels = {}
        now = datetime.now()
        specs = [
            ("day", "I dag", now),
            ("week", "Denne uken", now),
            ("month", "Denne måneden", now),
            ("year", "Dette året", now),
        ]
        for key, title, anchor in specs:
            box = ttk.Frame(frame, relief="groove", padding=10)
            box.pack(side="left", expand=True, fill="both", padx=5)
            ttk.Label(box, text=title, font=("Segoe UI", 10, "bold")).pack()
            value_label = ttk.Label(box, text="0t 0m", font=("Segoe UI", 14))
            value_label.pack()
            self.summary_labels[key] = value_label

    def _build_period_controls(self):
        frame = ttk.Frame(self.root, padding=10)
        frame.pack(fill="x")

        ttk.Button(frame, text="<", width=3, command=self._go_prev).pack(side="left")
        self.period_var = tk.StringVar(value=self.period)
        for p in PERIODS:
            ttk.Radiobutton(
                frame, text=PERIOD_LABELS[p], value=p, variable=self.period_var,
                command=self._on_period_change,
            ).pack(side="left", padx=5)
        ttk.Button(frame, text=">", width=3, command=self._go_next).pack(side="left")

        self.range_label = ttk.Label(frame, text="")
        self.range_label.pack(side="left", padx=15)

    def _build_chart(self):
        self.figure = Figure(figsize=(7, 4), dpi=100)
        self.ax = self.figure.add_subplot(111)
        self.canvas = FigureCanvasTkAgg(self.figure, master=self.root)
        self.canvas.get_tk_widget().pack(fill="both", expand=True, padx=10, pady=10)

    def _on_period_change(self):
        self.period = self.period_var.get()
        self.refresh()

    def _go_prev(self):
        self.anchor = _shift(self.period, self.anchor, -1)
        self.refresh()

    def _go_next(self):
        self.anchor = _shift(self.period, self.anchor, 1)
        self.refresh()

    def _refresh_summary(self):
        now = datetime.now()
        for key, label in self.summary_labels.items():
            start, end = _period_bounds(key, now)
            seconds = self.db.total_active_seconds_between(
                start.isoformat(timespec="seconds"), end.isoformat(timespec="seconds")
            )
            label.config(text=_format_hours(seconds))

    def _refresh_chart(self):
        start, end = _period_bounds(self.period, self.anchor)
        self.range_label.config(
            text=f"{start.strftime('%d.%m.%Y')} - {(end - timedelta(seconds=1)).strftime('%d.%m.%Y')}"
        )

        rows = self.db.app_usage_between(
            start.isoformat(timespec="seconds"), end.isoformat(timespec="seconds")
        )

        self.ax.clear()
        if rows:
            apps = [r[0] for r in rows[:10]]
            seconds = [r[1] / 3600 for r in rows[:10]]
            self.ax.barh(apps, seconds, color="#3498db")
            self.ax.invert_yaxis()
            self.ax.set_xlabel("Timer")
            self.ax.set_title("Tidsbruk per app")
        else:
            self.ax.text(0.5, 0.5, "Ingen data for denne perioden",
                          ha="center", va="center", transform=self.ax.transAxes)
        self.figure.tight_layout()
        self.canvas.draw()

    def refresh(self):
        self._refresh_summary()
        self._refresh_chart()

    def run(self):
        self.root.mainloop()


def open_dashboard(db: Database):
    """Åpner dashboardet. Trygt å kalle flere ganger (nytt vindu hver gang)."""
    with _tk_lock:
        Dashboard(db).run()


if __name__ == "__main__":
    open_dashboard(Database())
