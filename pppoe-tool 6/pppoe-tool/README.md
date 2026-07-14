# Mikrotik PPPoE Bulk Provisioner

Creates/updates PPPoE secrets on your CCR2116 (or any RouterOS 7.x device)
using the same admin username/password you use to log into the router's
web UI — no SSH keys, no separate API user.

## 0. One-time router check

This uses RouterOS's built-in REST API, which talks over the same HTTPS
service as the web UI. Two things to confirm on the router first:

1. **RouterOS version is 7.1 or later** (REST API was added in v7.1).
   Check under `System > Resources` (or `/system resource print` in
   terminal) — CCR2116 ships with RouterOS 7 by default, so this is
   almost certainly already fine.
2. **The `www-ssl` (or `www`) service is enabled.** In Winbox/Webfig:
   `IP > Services` — make sure `www-ssl` (port 443, the same one your
   browser uses) is not disabled. This is normally on by default.

No other configuration is needed — the script logs in exactly like your
browser does, just with HTTP Basic Auth instead of the login form.

## 1. Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:
```
MIKROTIK_HOST=192.168.88.1
MIKROTIK_PORT=443
MIKROTIK_USER=admin
MIKROTIK_PASSWORD=your-password-here
```

If your browser shows a certificate warning when you open
`https://<router-ip>` (very common with the router's default self-signed
cert), leave `MIKROTIK_VERIFY_CERT=false` in `.env`. Only set it to `true`
if you've installed a proper trusted certificate on the router.

## 2. Fill in the spreadsheet

Use `PPPOE_accounts_template.xlsx` as your starting point. Columns:

| Column     | Required | Notes                                                            |
|------------|----------|-------------------------------------------------------------------|
| Username   | Yes      | PPPoE login name                                                  |
| Password   | Yes      | PPPoE login password                                              |
| Type       | Yes      | Must be `PPPOE` (other rows are skipped, in case you add types later) |
| Profile    | Yes      | Must match an **existing** PPP profile on the router, e.g. `Plan100` |
| Local IP   | No       | Router-side address for that PPPoE link                           |
| Remote IP  | No       | Address assigned to the subscriber                                |
| Comment    | No       | Free text, e.g. customer name/address — shown in `/ppp secret print` |

Leave Local IP / Remote IP blank for any row where you want the profile's
default pool/local-address to apply instead of a fixed IP.

## 3. Dry run (recommended first)

This validates the spreadsheet and prints exactly what would be sent,
without contacting the router at all:

```bash
node create_pppoe_accounts.js PPPOE_accounts_template.xlsx --dry-run
```

Check the output carefully — bad rows are listed with the reason they were
skipped (missing fields, invalid IP, duplicate username, etc.).

## 4. Run for real

```bash
node create_pppoe_accounts.js PPPOE_accounts_template.xlsx
```

By default, usernames that already exist as PPP secrets are **skipped** (not
touched), so it's safe to re-run the same sheet repeatedly as you add new
rows. To instead overwrite existing accounts with the spreadsheet's values:

```bash
node create_pppoe_accounts.js PPPOE_accounts_template.xlsx --update
```

## What it actually does

It calls the RouterOS REST API, equivalent to running these commands
yourself in terminal:

- New accounts: `PUT /rest/ppp/secret` ≈ `/ppp secret add name=... password=... service=pppoe profile=... local-address=... remote-address=... comment=...`
- `--update` on existing accounts: `PATCH /rest/ppp/secret/<id>` ≈ `/ppp secret set [find name=...] ...`

## Notes / things worth double-checking on your setup

- **Profile must already exist.** The script does not create PPP profiles —
  it assumes `Plan100` (or whatever you put in the Profile column) is
  already configured under `/ppp profile`. If it doesn't exist, the router
  rejects the request and the row shows as FAIL with the router's error message.
- **IP conflicts aren't checked against the rest of your network** — only
  basic IPv4 format is validated. Since you're assigning IPs manually per
  row, make sure you're not reusing an address already handed out elsewhere.
- Requires Node.js 18+ (uses the built-in `fetch`).
- The admin password sits in plain text in your local `.env` file —
  treat that file like any other credential and don't commit or share it.

## Deploying `monitor.js` (the dashboard) to Railway

`monitor.js` is the uptime dashboard (`node monitor.js`, `http://localhost:3000`).
It's separate from `create_pppoe_accounts.js` (the bulk provisioner above),
which you keep running locally/manually — no need to deploy that one.

monitor.js gets its live PPPoE status and exact "logged out at" timestamps
by SSHing directly into your router — running `/ppp active print`, `/ppp
secret print`, and `/log print` over SSH, the same way you'd type them into
a terminal. For StarLine, that's the remote-access provider's relayed SSH
port (`remoteanyx888.jrandombytes.com:26248`) — the same port TaokiNinam
itself uses to reach the router, so it's already known to work.

Customer info (name, account number, contact number, area, NAP box) is an
**optional** enrichment layer sourced from TaokiNinam (taokininam.com) and
matched onto router accounts by username. If you skip the TaokiNinam
variables, the dashboard still works fully — those columns just stay blank.

1. **Push this folder to a GitHub repo** (`.gitignore` already excludes
   `.env` and `node_modules` — don't commit real credentials).
2. **Create a Railway project** from that repo. Railway auto-detects Node
   and runs `npm start`, which runs `node monitor.js`. A `Procfile` is
   included as a backup in case Railway's detection needs it spelled out.
3. **Set environment variables** in Railway's dashboard (Settings → Variables)
   — do not upload `.env` itself:
   - `MIKROTIK_SSH_HOST=remoteanyx888.jrandombytes.com` — **required**
   - `MIKROTIK_SSH_PORT=26248` — **required** (this is the relay's SSH port —
     different from 26246 Winbox and 26247 REST API)
   - `MIKROTIK_SSH_USER`, `MIKROTIK_SSH_PASSWORD` — **required**, same router
     admin login you use in Winbox
   - `TAOKININAM_USERNAME`, `TAOKININAM_PASSWORD` (optional — enables customer
     name/account/contact/area/NAP box columns)
   - `MONITOR_POLL_INTERVAL=30` (optional, this is the default)
   - `MONITOR_ALERT_THRESHOLD` (optional, same as local)
   - Don't set `MONITOR_PORT`/`PORT` — Railway injects `PORT` automatically and
     the app binds to it.
   - You do **not** need `MIKROTIK_HOST`/`MIKROTIK_PORT`/`MIKROTIK_USER` (no
     `_SSH_` in the name) here — those are for `create_pppoe_accounts.js`,
     which you run locally.
4. **Since this port is internet-facing with router-admin SSH credentials**,
   keep `MIKROTIK_SSH_PASSWORD` strong, and ask your provider whether that
   port can be source-IP-restricted to Railway's egress ranges.
5. **ISP uplink pings**: these ping the 5 ISP gateway IPs directly from
   wherever the process runs. Once this runs on Railway, those pings will
   reflect Railway's own connectivity to those IPs, not your site's actual
   uplinks — this part of the dashboard won't be meaningful in the cloud
   deployment unless it's changed to get uplink status from something
   running at your site instead.

## Alternative: run locally + Cloudflare Tunnel

If you'd rather not put router SSH credentials on Railway, or want the ISP
uplink pings to reflect your actual site connectivity, run `monitor.js` on
an always-on machine at your site (a mini PC, an old desktop, a Raspberry
Pi) and only expose the *dashboard page* to the internet. In this setup you
could even point `MIKROTIK_SSH_HOST` at the router's LAN IP on port 22
instead of the relay, since you're already on the same network.

1. **Use the same `.env`** as above.

2. **Keep it running persistently**, so it survives reboots/crashes:
   - **macOS/Linux**: pm2, with the built-in boot hook.
     ```
     npm install -g pm2
     pm2 start monitor.js --name starline-monitor
     pm2 save
     pm2 startup
     ```
   - **Windows**: `pm2 startup` doesn't work the same way on Windows, so use
     either:
     - **NSSM** (simplest — wraps `node monitor.js` as a real Windows
       Service): download NSSM, then `nssm install StarlineMonitor
       "C:\Program Files\nodejs\node.exe" "C:\path\to\monitor.js"`, set
       the "Startup directory" to the project folder in the NSSM GUI, then
       `nssm start StarlineMonitor`. It'll now run in the background and
       restart automatically on reboot/crash.
     - Or pm2 + `pm2-windows-startup`: `npm install -g pm2
       pm2-windows-startup`, then `pm2 start monitor.js --name
       starline-monitor`, `pm2 save`, `pm2-startup install`.

3. **Install Cloudflare Tunnel** on that same machine:
   - macOS: `brew install cloudflared`
   - Windows: download the `.msi` installer from Cloudflare's
     [cloudflared releases page](https://github.com/cloudflare/cloudflared/releases),
     or `winget install --id Cloudflare.cloudflared`.

4. **Log in and create a tunnel**:
   ```
   cloudflared tunnel login
   cloudflared tunnel create starline-monitor
   ```

5. **Configure it** — create the config file:
   - macOS/Linux: `~/.cloudflared/config.yml`
   - Windows: `C:\Users\<you>\.cloudflared\config.yml`
   ```
   tunnel: starline-monitor
   credentials-file: /path/to/<tunnel-id>.json
   ingress:
     - hostname: starline.yourdomain.com
       service: http://localhost:3000
     - service: http_status:404
   ```
   (On Windows, use the Windows-style path for `credentials-file`, e.g.
   `C:\Users\you\.cloudflared\<tunnel-id>.json`. Requires a domain added
   to a free Cloudflare account. Don't have one handy?
   `cloudflared tunnel --url http://localhost:3000` gives an instant but
   temporary `trycloudflare.com` URL, good for testing only.)

6. **Point DNS at the tunnel**:
   ```
   cloudflared tunnel route dns starline-monitor starline.yourdomain.com
   ```

7. **Run it as a persistent service** (starts on boot, like pm2 above):
   ```
   cloudflared service install
   ```

8. **Gate it behind a login** — the dashboard shows customer names,
   contact numbers, and addresses (NAP box/area), so this shouldn't be a
   fully open public URL. In Cloudflare Zero Trust → Access →
   Applications, add a policy requiring email login before the page
   loads (free for a handful of users).

### Running this on a Raspberry Pi 3

Raspberry Pi OS is Debian-based, so steps 1-2 and 4-8 above work exactly
as written (pm2's Linux `pm2 startup` applies directly — no NSSM needed).
A few Pi-specific things to get right:

- **Flash 64-bit Raspberry Pi OS Lite** (headless, no desktop) using the
  Raspberry Pi Imager — the Pi 3's CPU supports 64-bit, and Node.js runs
  better on the 64-bit build. In the Imager's settings (gear icon) before
  writing, pre-configure hostname, enable SSH, and set WiFi credentials
  so it boots headless and reachable immediately.
- **Use a high-endurance microSD card** (e.g. SanDisk High Endurance,
  or an industrial-rated card), not a standard consumer card. A card
  running a 24/7 Node process for months/years wears out faster than
  normal use, and corruption is the single most common way these setups
  fail. If your Pi 3 model/OS supports USB boot, booting from a small
  USB SSD instead of the SD card is even more reliable — worth doing if
  you already have a spare USB drive.
- **Install Node.js** via NodeSource's setup script (gives you an ARM64
  build matching the 64-bit OS):
  ```
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
- **Install cloudflared** via Cloudflare's apt repo (has ARM64 builds):
  see [Cloudflare's install docs](https://pkg.cloudflare.com/index.html)
  for the `cloudflared` apt source, or download the `arm64` `.deb`
  directly from the
  [cloudflared releases page](https://github.com/cloudflare/cloudflared/releases).
- **Give the Pi a static LAN IP** (DHCP reservation in the router's DHCP
  settings, keyed to the Pi's MAC address) so its address never changes
  and stays reachable for SSH/troubleshooting.
- **Consider a small UPS/power bank HAT** if grid power at the site isn't
  rock-solid — an abrupt power loss mid-write is what actually corrupts
  SD cards, more than age/wear alone.
