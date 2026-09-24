#!/usr/bin/env python3
"""Small native Fedora window for the CIEL host web UI."""

import os
import sys
from pathlib import Path
from urllib.parse import urlparse

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gio, GLib, Gtk, WebKit2  # noqa: E402


CIEL_URL = "http://127.0.0.1:4317/"


class CielApplication(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="io.ciel.Ciel", flags=Gio.ApplicationFlags.NON_UNIQUE)

    def do_activate(self):
        Gtk.Settings.get_default().set_property("gtk-application-prefer-dark-theme", True)
        data_home = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
        cache_home = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
        web_data = data_home / "ciel" / "webview"
        web_cache = cache_home / "ciel" / "webview"
        web_data.mkdir(parents=True, exist_ok=True)
        web_cache.mkdir(parents=True, exist_ok=True)

        manager = WebKit2.WebsiteDataManager(
            base_data_directory=str(web_data), base_cache_directory=str(web_cache)
        )
        context = WebKit2.WebContext.new_with_website_data_manager(manager)
        view = WebKit2.WebView.new_with_context(context)
        view.set_hexpand(True)
        view.set_vexpand(True)
        view.connect("decide-policy", self.on_decide_policy)
        view.connect("load-failed", self.on_load_failed)

        window = Gtk.ApplicationWindow(application=self)
        window.set_title("CIEL")
        window.set_default_size(1400, 900)
        window.set_size_request(900, 560)
        icon = Path(__file__).resolve().parent.parent / "ciel.svg"
        if icon.exists():
            window.set_icon_from_file(str(icon))
        header = Gtk.HeaderBar()
        header.set_title("CIEL")
        header.set_show_close_button(True)
        header.set_decoration_layout(":minimize,maximize,close")
        window.set_titlebar(header)
        window.add(view)
        window.show_all()
        view.load_uri(CIEL_URL)

    @staticmethod
    def on_decide_policy(view, decision, kind):
        if kind not in (
            WebKit2.PolicyDecisionType.NAVIGATION_ACTION,
            WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION,
        ):
            return False
        uri = decision.get_navigation_action().get_request().get_uri()
        parsed = urlparse(uri)
        if parsed.hostname in ("127.0.0.1", "localhost") and parsed.port == 4317:
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
        if uri.startswith(CIEL_URL.rstrip("/")):
            def retry():
                view.load_uri(CIEL_URL)
                return GLib.SOURCE_REMOVE

            GLib.timeout_add_seconds(2, retry)
        return False


if __name__ == "__main__":
    sys.exit(CielApplication().run(sys.argv))
