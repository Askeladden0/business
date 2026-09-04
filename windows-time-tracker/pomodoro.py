"""Pomodoro-stil pause-påminnelser.

Teller sammenhengende aktivt arbeid (kalles kun med tick() mens økten er
aktiv, ikke idle) og trigger on_break_due når work_minutes er nådd.
Verdiene styres fra config.json (pomodoro.work_minutes/break_minutes) -
ingen hardkoding her.
"""
import logging
from typing import Callable, Optional

from config import POMODORO_BREAK_MINUTES, POMODORO_WORK_MINUTES

logger = logging.getLogger(__name__)


class PomodoroTimer:
    def __init__(
        self,
        on_break_due: Optional[Callable[[], None]] = None,
        work_minutes: int = POMODORO_WORK_MINUTES,
        break_minutes: int = POMODORO_BREAK_MINUTES,
    ):
        self.on_break_due = on_break_due
        self.work_seconds = work_minutes * 60
        self.break_seconds = break_minutes * 60
        self._elapsed = 0
        self._paused = False

    def reset(self):
        self._elapsed = 0
        self._paused = False

    def pause(self):
        self._paused = True

    def resume(self):
        self._paused = False

    def tick(self, seconds: int):
        if self._paused:
            return
        self._elapsed += seconds
        if self._elapsed >= self.work_seconds:
            self._elapsed = 0
            logger.info("Pomodoro: tid for pause (%s min pause anbefalt)",
                        self.break_seconds // 60)
            if self.on_break_due:
                self.on_break_due()

    @property
    def minutes_until_break(self) -> float:
        return max(0.0, (self.work_seconds - self._elapsed) / 60)
