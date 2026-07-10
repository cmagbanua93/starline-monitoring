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

1. **Push this folder to a GitHub repo** (`.gitignore` already excludes
   `.env` and `node_modules` — don't commit real credentials).
2. **Create a Railway project** from that repo. Railway auto-detects Node
   and runs `npm start`, which now runs `node monitor.js` (fixed — it used
   to point at the provisioner by mistake). A `Procfile` is included as a
   backup in case Railway's detection needs it spelled out.
3. **Set environment variables** in Railway's dashboard (Settings → Variables)
   — do not upload `.env` itself:
   - `MIKROTIK_HOST=remoteanyx888.jrandombytes.com`
   - `MIKROTIK_PORT=26247` (this is your remote-access provider's forwarded
     port for the router's REST API — different from the 26246 Winbox port
     and the 26248 SSH port they also gave you)
   - `MIKROTIK_PROTOCOL=https` (**required** — the app would otherwise guess
     `http` since port 26247 doesn't match RouterOS's default 443/8729, and
     the connection would fail)
   - `MIKROTIK_USER`, `MIKROTIK_PASSWORD` — same router admin login as local
   - `MIKROTIK_VERIFY_CERT=false` (unless you've since installed a trusted
     cert on the router)
   - `TAOKININAM_USERNAME`, `TAOKININAM_PASSWORD` (optional — billing columns)
   - `MONITOR_POLL_INTERVAL`, `MONITOR_ALERT_THRESHOLD` (optional, same as local)
   - Don't set `MONITOR_PORT`/`PORT` — Railway injects `PORT` automatically and
     the app now binds to it.
4. **Router reachability**: your router reaches out to a remote-access
   provider via an SSTP client (configured on the router itself), and the
   provider relays specific ports back to the internet on
   `remoteanyx888.jrandombytes.com` (26246 → Winbox, 26247 → REST API,
   26248 → SSH). That REST API port is a normal internet-reachable endpoint,
   so Railway can hit it directly — no VPN client needs to run inside the
   Railway container. Since it's internet-facing with router-admin
   credentials, keep `MIKROTIK_PASSWORD` strong and ask your provider
   whether that port can be source-IP-restricted.
5. **ISP uplink pings**: these ping the 5 ISP gateway IPs directly from
   wherever the process runs. Once this runs on Railway, those pings will
   reflect Railway's own connectivity to those IPs, not your site's actual
   uplinks — this part of the dashboard won't be meaningful in the cloud
   deployment unless it's changed to get uplink status from something
   running at your site instead.
