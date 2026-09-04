"""Enkle tkinter-popupvinduer: oppstartsspørsmål og pause-påminnelse."""
import threading
import tkinter as tk

# Popup-vinduer kan trigges fra ulike tråder (oppstart vs. sporingstråden
# som varsler om pause). Tkinter er ikke trådsikkert, så vi serialiserer
# all vindus-oppretting med denne låsen for å unngå at to Tk()-instanser
# opprettes samtidig fra forskjellige tråder.
_tk_lock = threading.Lock()


def ask_start_session() -> bool:
    """Viser 'Start arbeidsøkt?' med Ja/Nei. Returnerer True hvis Ja."""
    result = {"start": False}

    _tk_lock.acquire()
    try:
        return _ask_start_session_impl(result)
    finally:
        _tk_lock.release()


def _ask_start_session_impl(result) -> bool:
    root = tk.Tk()
    root.title("Tidssporing")
    root.attributes("-topmost", True)
    root.resizable(False, False)

    width, height = 300, 120
    screen_w = root.winfo_screenwidth()
    screen_h = root.winfo_screenheight()
    root.geometry(f"{width}x{height}+{(screen_w - width)//2}+{(screen_h - height)//2}")

    tk.Label(root, text="Start arbeidsøkt?", font=("Segoe UI", 12)).pack(pady=(20, 10))

    button_frame = tk.Frame(root)
    button_frame.pack()

    def on_yes():
        result["start"] = True
        root.destroy()

    def on_no():
        result["start"] = False
        root.destroy()

    tk.Button(button_frame, text="Ja", width=10, command=on_yes).pack(side="left", padx=10)
    tk.Button(button_frame, text="Nei", width=10, command=on_no).pack(side="left", padx=10)

    root.protocol("WM_DELETE_WINDOW", on_no)
    root.mainloop()
    return result["start"]


def show_break_reminder(break_minutes: int):
    """Viser en ikke-blokkerende påminnelse om å ta pause."""
    with _tk_lock:
        _show_break_reminder_impl(break_minutes)


def _show_break_reminder_impl(break_minutes: int):
    root = tk.Tk()
    root.title("Ta en pause")
    root.attributes("-topmost", True)
    root.resizable(False, False)

    width, height = 320, 130
    screen_w = root.winfo_screenwidth()
    screen_h = root.winfo_screenheight()
    root.geometry(f"{width}x{height}+{(screen_w - width)//2}+{(screen_h - height)//2}")

    tk.Label(
        root,
        text=f"Du har jobbet en stund.\nTa en pause på {break_minutes} minutter!",
        font=("Segoe UI", 11),
        justify="center",
    ).pack(pady=(20, 10))

    tk.Button(root, text="OK", width=10, command=root.destroy).pack()

    # Lukk automatisk etter 30 sekunder hvis brukeren ikke reagerer.
    root.after(30_000, root.destroy)
    root.mainloop()
