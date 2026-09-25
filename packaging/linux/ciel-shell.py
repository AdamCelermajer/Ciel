#!/usr/bin/env python3
"""Small native Fedora window for the CIEL host web UI."""

import os
import sys
from pathlib import Path
from urllib.parse import urlparse

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2  # noqa: E402


CIEL_URL = os.environ.get("CIEL_SHELL_URL", "http://127.0.0.1:4317/")
CIEL_ORIGIN = urlparse(CIEL_URL)
CIEL_PROFILE = os.environ.get("CIEL_SHELL_PROFILE", "ciel")
CIEL_APP_ID = os.environ.get("CIEL_SHELL_APP_ID", "io.ciel.Ciel")
CIEL_TITLE = os.environ.get("CIEL_SHELL_TITLE", "CIEL")
ZOOM_MIN = 0.6
ZOOM_MAX = 2.0
ZOOM_STEP = 0.1


class CielApplication(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=CIEL_APP_ID, flags=Gio.ApplicationFlags.NON_UNIQUE)

    def do_activate(self):
        Gtk.Settings.get_default().set_property("gtk-application-prefer-dark-theme", True)
        data_home = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
        cache_home = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
        web_data = data_home / CIEL_PROFILE / "webview"
        web_cache = cache_home / CIEL_PROFILE / "webview"
        web_data.mkdir(parents=True, exist_ok=True)
        web_cache.mkdir(parents=True, exist_ok=True)

        manager = WebKit2.WebsiteDataManager(
            base_data_directory=str(web_data), base_cache_directory=str(web_cache)
        )
        context = WebKit2.WebContext.new_with_website_data_manager(manager)
        view = WebKit2.WebView.new_with_context(context)
        view.set_hexpand(True)
        view.set_vexpand(True)
        self.zoom_file = web_data / "zoom-level"
        try:
            saved_zoom = float(self.zoom_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            saved_zoom = 1.0
        view.set_zoom_level(max(ZOOM_MIN, min(ZOOM_MAX, saved_zoom)))
        view.connect("key-press-event", self.on_key_press)
        view.connect("scroll-event", self.on_scroll)
        view.connect("decide-policy", self.on_decide_policy)
        view.connect("load-failed", self.on_load_failed)

        window = Gtk.ApplicationWindow(application=self)
        window.set_title(CIEL_TITLE)
        window.set_default_size(1400, 900)
        window.set_size_request(900, 560)
        icon = Path(__file__).resolve().parent.parent / "ciel.svg"
        if icon.exists():
            window.set_icon_from_file(str(icon))
        header = Gtk.HeaderBar()
        header.set_title(CIEL_TITLE)
        header.set_show_close_button(True)
        header.set_decoration_layout(":minimize,maximize,close")
        window.set_titlebar(header)
        window.add(view)
        window.show_all()
        view.load_uri(CIEL_URL)

    def set_zoom(self, view, level):
        level = max(ZOOM_MIN, min(ZOOM_MAX, round(level, 1)))
        view.set_zoom_level(level)
        try:
            self.zoom_file.write_text(f"{level:.1f}", encoding="utf-8")
        except OSError:
            pass

    def on_key_press(self, view, event):
        if not event.state & Gdk.ModifierType.CONTROL_MASK:
            return False
        key = Gdk.keyval_name(event.keyval)
        if key in ("plus", "equal", "KP_Add"):
            self.set_zoom(view, view.get_zoom_level() + ZOOM_STEP)
        elif key in ("minus", "KP_Subtract"):
            self.set_zoom(view, view.get_zoom_level() - ZOOM_STEP)
        elif key in ("0", "KP_0"):
            self.set_zoom(view, 1.0)
        else:
            return False
        return True

    def on_scroll(self, view, event):
        if not event.state & Gdk.ModifierType.CONTROL_MASK:
            return False
        if event.direction == Gdk.ScrollDirection.SMOOTH:
            _, _, delta_y = event.get_scroll_deltas()
        elif event.direction == Gdk.ScrollDirection.UP:
            delta_y = -1
        elif event.direction == Gdk.ScrollDirection.DOWN:
            delta_y = 1
        else:
            return False
        if delta_y:
            self.set_zoom(view, view.get_zoom_level() + (-ZOOM_STEP if delta_y > 0 else ZOOM_STEP))
        return True

    @staticmethod
    def on_decide_policy(view, decision, kind):
        if kind not in (
            WebKit2.PolicyDecisionType.NAVIGATION_ACTION,
            WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION,
        ):
            return False
        uri = decision.get_navigation_action().get_request().get_uri()
        parsed = urlparse(uri)
        if parsed.scheme == CIEL_ORIGIN.scheme and parsed.hostname == CIEL_ORIGIN.hostname and parsed.port == CIEL_ORIGIN.port:
            if kind == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION:
                view.load_uri(uri)
                decision.ignore()
                return True
            return False
        if parsed.scheme in ("http", "https", "mailto"):
            Gio.AppInfo.launch_default_for_uri(uri, None)
        decision.ignore()
        return True

    @staticmethod
    def on_load_failed(view, _event, uri, _error):
        parsed = urlparse(uri)
        if parsed.scheme == CIEL_ORIGIN.scheme and parsed.hostname == CIEL_ORIGIN.hostname and parsed.port == CIEL_ORIGIN.port:
            def retry():
                view.load_uri(CIEL_URL)
                return GLib.SOURCE_REMOVE

            GLib.timeout_add_seconds(2, retry)
        return False


if __name__ == "__main__":
    sys.exit(CielApplication().run(sys.argv))
