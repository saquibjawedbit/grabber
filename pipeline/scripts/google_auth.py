#!/usr/bin/env python3
"""Get a Google refresh token for Intelly's Gmail + Calendar senses.

Google won't hand out a refresh token without a human clicking "Allow" once. This
does that in ~2 minutes and prints the three values to hand back.

Setup (one time, in console.cloud.google.com):
  1. New project (any name).
  2. APIs & Services -> Library -> enable "Gmail API" and "Google Calendar API".
  3. APIs & Services -> OAuth consent screen -> External -> fill the required
     fields -> Audience -> Test users -> add your own gmail address.
  4. Credentials -> Create credentials -> OAuth client ID -> Desktop app.
     Copy the client ID and client secret.

Then:
  python3 pipeline/scripts/google_auth.py

Read-only scopes: this can never send mail or change your calendar.
"""
import http.server
import json
import secrets
import socketserver
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser

SCOPES = " ".join([
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
])
PORT = 8765
REDIRECT = f"http://localhost:{PORT}/callback"

_code = {}


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass  # the console is for the user, not for access logs

    def do_GET(self):
        q = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(q)
        if "code" in params:
            _code["code"] = params["code"][0]
            _code["state"] = params.get("state", [""])[0]
            body = b"<h2>Done.</h2><p>Intelly is connected. You can close this tab.</p>"
        else:
            _code["error"] = params.get("error", ["unknown"])[0]
            body = b"<h2>Denied.</h2><p>Nothing was connected. Close this tab and re-run.</p>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    client_id = input("Client ID: ").strip()
    client_secret = input("Client secret: ").strip()
    if not client_id or not client_secret:
        raise SystemExit("Both are required — see the setup steps at the top of this file.")

    state = secrets.token_urlsafe(16)
    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": REDIRECT,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",
        "prompt": "consent",          # forces a refresh token even on re-auth
        "state": state,
    })

    socketserver.TCPServer.allow_reuse_address = True
    server = socketserver.TCPServer(("localhost", PORT), Handler)
    threading.Thread(target=server.handle_request, daemon=True).start()

    print("\nOpening your browser. Approve the two read-only scopes.")
    print(f"If nothing opens, paste this in yourself:\n\n{auth_url}\n")
    webbrowser.open(auth_url)

    for _ in range(120):
        if _code:
            break
        threading.Event().wait(1)
    server.server_close()

    if "error" in _code:
        raise SystemExit(f"Google said: {_code['error']}")
    if "code" not in _code:
        raise SystemExit("Timed out waiting for the browser. Re-run and approve faster.")
    if _code.get("state") != state:
        raise SystemExit("State mismatch — abandoning, this is not the response we asked for.")

    data = urllib.parse.urlencode({
        "code": _code["code"],
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": REDIRECT,
        "grant_type": "authorization_code",
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data)
    with urllib.request.urlopen(req, timeout=30) as r:
        tok = json.loads(r.read())

    refresh = tok.get("refresh_token")
    if not refresh:
        raise SystemExit("Google returned no refresh token. Revoke the app at "
                         "myaccount.google.com/permissions and run this again.")

    print("\n" + "=" * 64)
    print("Set these three on the Worker (or paste them to Claude):\n")
    print(f"  GOOGLE_CLIENT_ID      {client_id}")
    print(f"  GOOGLE_CLIENT_SECRET  {client_secret}")
    print(f"  GOOGLE_REFRESH_TOKEN  {refresh}")
    print("=" * 64)
    print("\nThey are read-only and revocable any time at myaccount.google.com/permissions")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(1)
