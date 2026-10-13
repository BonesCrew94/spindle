# Spindle

A self-hosted podcast player that installs to your phone's home screen.
Subscribe to feeds, listen, and have your position follow you between
devices — on a server you control, with no account anywhere but your own.

- **No build step.** The app is one `index.html` file. No framework, no
  bundler, no npm packages on either side.
- **No database.** The server is plain Node using only its standard library,
  storing JSON files on disk.
- **Two containers' worth of features in one small one.** It serves the app
  and the sync API from the same port, so there is no CORS to fight and no
  server address to type into the app.

---

## What you get

**Listening**

- Subscribe by searching the Apple Podcasts directory, or paste any RSS URL
  (which covers private and members-only feeds).
- Position saves every few seconds; tapping an episode resumes where you were.
- Episodes auto-mark as played past 95%, with a progress ring and time
  remaining on partly-heard ones.
- Filter by All / Unplayed / Played / In progress, and sort newest or oldest
  first — useful for starting a long-running show from episode 1.
- Playback speed, sleep handling, and a built-in **Up Next** queue alongside
  any playlists you make.
- Cast to Chromecast, Google TV and Nest speakers; AirPlay on iOS. Playback
  hands off mid-episode and your position keeps saving.

**Accounts and sync**

- Real accounts: scrypt-hashed passwords, HttpOnly session cookies, and each
  account able to reach only its own listening history.
- Two people on one server get completely separate libraries.
- Your own library follows you between phone, tablet and desktop.
- Offline is fine. Changes are kept locally and pushed when the server is
  reachable again.
- Or skip accounts entirely — "use this device without an account" is a real
  local-only mode, not a degraded fallback.

**As an app**

- Installs as a proper PWA with its own home-screen icon, opening fullscreen
  with no browser chrome.
- Opens without a connection.

---

## Requirements

- Docker and Docker Compose.
- A way to serve it over **HTTPS** (see below). This is not optional for the
  home-screen install or for casting — both browsers refuse them otherwise.

That's the whole list. No Node install, no package manager, no database.

---

## Quick start

```bash
git clone https://github.com/bonescrew94/spindle.git
cd spindle
docker compose up -d
docker compose logs spindle
```

The log ends with something like:

```
====================================================
  FIRST RUN - setup code for creating your account:

      K7PQR-2MXTL-9HBWE-4NCJZ

  Open the app and enter it. It stops working as soon
  as the first account exists.
====================================================
```

Open `http://localhost:8088`, enter that code, and pick a name and password.
The code is spent the moment your account exists.

**Why a code at all?** Creating the first account is the one moment the
server has nobody to check you against. Without the code, whoever reached
the port first would own the server. It is also written to
`data/setup-token.txt` if you miss it in the log, and that file is deleted
along with it.

If you ever delete `data/users.json`, a fresh code is generated on the next
start and the server goes back to this state.

---

## Serving it over HTTPS

The app works over plain HTTP for testing, but you need HTTPS for the two
things that make it feel like an app:

- **Installing to the home screen.** Over plain HTTP, Chrome still offers
  "Install" and then quietly gives you a bookmark that reopens in the
  browser. An IP address counts as plain HTTP no matter what.
- **Casting.** The Google Cast SDK will not load on an insecure origin.

Any of these work:

**A reverse proxy you already run** — Caddy, nginx, Traefik, Nginx Proxy
Manager. Point it at `http://<host>:8088` and give it a certificate. Make
sure websockets and streaming pass through untouched.

**Tailscale**, if you would rather not expose anything publicly. One command
gets you a real certificate on a private hostname reachable from anywhere
you are signed in:

```bash
tailscale serve --bg 8088
```

**A tunnel** such as Cloudflare Tunnel, if you want it reachable without a
public IP.

Once it is on HTTPS, uncomment `SECURE_COOKIES=1` in `docker-compose.yml` so
the session cookie is never sent over a plain connection, then
`docker compose up -d`.

---

## Installing on a phone

- **Android / Chrome** — open the HTTPS URL, then ⋮ → *Install app*. You get
  a real WebAPK that appears in Settings → Apps as its own entry. Firefox on
  Android cannot do this; its shortcuts always reopen in Firefox.
- **iPhone / Safari** — Share → *Add to Home Screen*. Only Safari can do this
  on iOS; Chrome and Firefox there can only make bookmarks.

---

## Configuration

Set these in `docker-compose.yml`.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8088` | Port the server listens on. |
| `DATA_DIR` | `/data` | Accounts, sessions and listening history. |
| `PUBLIC_DIR` | `/srv/public` | Where the app files are served from. |
| `SECURE_COOKIES` | off | Set to `1` behind HTTPS so the session cookie is never sent in the clear. |
| `SESSION_DAYS` | `30` | How long a sign-in lasts. |
| `TZ` | `Etc/UTC` | Container timezone. |

---

## Backups

`data/` holds both accounts and every listening position, and it is the only
thing here that cannot be rebuilt. Everything else is in this repository.

```
data/
  users.json        names, scrypt hashes, salts
  sessions.json     live sign-ins
  state/
    <account>.json  one file per account
```

Writes are atomic — a temp file then a rename — so a crash mid-write cannot
leave a truncated account. That is not a backup. Copy the folder somewhere
else on a schedule.

Losing it loses the accounts too, which puts the server back to first-run
with a new setup code.

---

## How it works

```
  phone / tablet / desktop
          |
          v
  your reverse proxy or tunnel          <- HTTPS lives here
          |
          v
  container "spindle"  (node:22-alpine)
          |
          |-- serves the app          /srv/public   (read only)
          |-- runs server.js          /srv/app      (read only)
          |-- fetches feeds outbound  -> the internet
          \-- reads + writes history  /data
```

**Feeds are fetched by the server, not the browser.** Podcast hosts rarely
send CORS headers, so the browser cannot fetch most feeds directly. Requests
go out from your server instead, which means no CORS to work around and no
third-party proxy in the path. The browser only ever talks to your server,
plus the podcast host for the audio itself.

The feed endpoint resolves hostnames first and refuses private, loopback and
CGNAT addresses, so it cannot be used to probe the rest of your network.

**Sync merges per key, not per document.** Every value carries the moment it
last changed on the device that changed it, and the server keeps whichever
side is newer:

| What | How it merges |
|---|---|
| Listening position | Per episode. You on episode 4 and someone else on episode 9 both stick. |
| Subscriptions | Per show. Unsubscribing writes a tombstone rather than deleting, or the other device's stale copy would re-add it. |
| Playlists | Per playlist, tombstoned on delete. Editing different lists on two devices keeps both. |
| Up Next | As a whole — merging an ordered queue item by item would scramble it. |
| Speed, sort, filter | Per setting. |

### API

Everything lives under `/api/`; all other paths are static files.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/auth/status` | Whether setup is needed, and who you are. |
| `POST` | `/api/auth/login` | Name and password in, session cookie out. Rate limited. |
| `POST` | `/api/auth/register` | Creates an account. Needs the setup code for the first one, a session for any after that. |
| `POST` | `/api/auth/logout` | Ends this session. |
| `POST` | `/api/auth/password` | Changes your password and signs out every other device. |
| `GET` | `/api/state` | Your library, positions, playlists and queue. |
| `POST` | `/api/state` | Merges what you send with what is stored, returns the result. |
| `GET` | `/api/feed?url=…` | Fetches a podcast feed server-side. |
| `GET` | `/api/search?term=…` | Searches the Apple Podcasts directory. |
| `GET` | `/api/accounts` | Account names only. |

---

## Security

- Passwords go through scrypt with a per-account salt — deliberately slow and
  memory-hard, so `users.json` is not a list of passwords even if someone
  walks off with it.
- Sessions are HttpOnly cookies, which JavaScript cannot read.
- Login attempts are capped at 10 per 15 minutes per address, and setup-code
  attempts share that limit.
- Wrong name and wrong password return the same message, so the form cannot
  be used to discover who has an account.
- Changing a password signs out every other device.
- There is no endpoint that will hand you someone else's history.

This is built for a private server — your own machine, a home network, a
tailnet. It has had no third-party security audit. If you put it on the open
internet, put it behind something that terminates TLS, and set
`SECURE_COOKIES=1`.

---

## Updating

```bash
git pull
docker compose up -d
```

The app updates itself on devices. The service worker fetches the page from
the network first and only falls back to its cache when offline, so a deploy
lands the next time the app is opened. If something is playing, the reload
waits until it is not.

If you are developing and want to force the issue, a hard refresh
(`Ctrl+Shift+R`) or a desktop private window bypasses the worker entirely.

---

## Troubleshooting

**The app loads but the sync dot is red.** The interface is cached, so it
opens happily while every API call fails. Check the server directly:

```bash
curl -s http://127.0.0.1:8088/api/auth/status
```

JSON back means the server is fine. An error means the container is down —
`docker compose logs spindle`.

**Chrome installs it but it still opens with an address bar.** You are on an
HTTP address. See *Serving it over HTTPS*.

**New episodes never appear.** The refresh button on the library screen
checks every show and reports what it found. Feeds are also re-checked when
you open a show and when you return to the app after fifteen minutes away.

**Adding a podcast fails.** The error names the failing step — "the feed host
returned 404", "that URL returned text/html, not a podcast feed". If search
fails too, the server cannot reach the internet; check its DNS. If one
specific show fails while others work, Apple may be pointing at a dead feed
for a show that changed hosts — get the current RSS URL from the show's own
site and paste that in instead.

**`Cannot find module '/srv/app/server.js'`.** The mount is fine, the file
is not where it is expected. Check for a wrong folder name, or a file that
really is `server.js.txt` because the editor added an extension.

**I lost the setup code.** It is in `data/setup-token.txt` until the first
account is made. If the account already exists, the code is gone on purpose —
sign in instead.

---

## Contributing

Issues and pull requests are welcome. The app is one HTML file and the server
is one JS file; there is no build to run, so editing either and restarting
the container is the whole development loop.

```
app/
  index.html        the entire app - UI, feed parsing, player, cast
  sw.js             service worker; app shell only, never the API
  manifest.json     makes it installable
  icon*.png/svg     icons
sync-server/
  server.js         accounts, sync, feed fetching, static serving
docker-compose.yml
```

Two things worth knowing before changing them:

- **The service worker must never cache anything under `/api/`.** Feed
  fetching is same-origin, so a cache-first rule there means the first copy
  of a feed answers forever and new episodes never arrive.
- **`server.js` is read once at startup** from a read-only mount, so changes
  to it need the container recreated, not just restarted.

---

## Licence

MIT. See [LICENSE](LICENSE).
