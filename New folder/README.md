# 🫡 Papa's Almanac — sync server (free hosting guide)

This little server saves each account's planner and sends push reminders, so the app
**syncs across his Mac, iPhone & iPad** and reminds him even when it's closed.

You'll host it for **free** with three free, no-credit-card services:

| What | Why | Cost |
|------|-----|------|
| **Turso** | stores the data (so it's never lost) | free |
| **Render** | runs the server on the internet | free |
| **cron-job.org** | pings it every few minutes so reminders fire on time | free |

> Heads-up: free hosting "sleeps" when idle — the cron ping keeps it awake. It's perfect
> for one family. If you'd ever rather have a dead-simple, never-sleeps version, a ~$5/month
> Render plan removes the cron step and the sleeping. Just ask me.

---

## Step 1 — Create the free database (Turso)
1. Go to **https://turso.tech** → sign up (free, no card).
2. In the dashboard, **Create Database** (any name, e.g. `papas-almanac`).
3. Open it → copy two things:
   - the **Database URL** (looks like `libsql://papas-almanac-xxxx.turso.io`)
   - **Create Token** → copy the **auth token**.
   Keep both handy for Step 2.

## Step 2 — Put the server online (Render)
1. Put this **`papa-almanac-server`** folder in a GitHub repo
   (github.com → New repository → upload the files — same as the app).
2. Go to **https://render.com** → sign up (free) → **New → Web Service** → connect that repo.
3. Render auto-detects the settings from `render.yaml`. Choose the **Free** plan.
4. Under **Environment**, add the two values from Turso:
   - `TURSO_DATABASE_URL` = the libsql:// URL
   - `TURSO_AUTH_TOKEN`  = the token
5. **Create Web Service.** After a minute you get an address like
   **`https://papas-almanac-server.onrender.com`** — that's your sync server. ✅
   (Check it works: open `…onrender.com/api/health` — it should say `{"ok":true …}`.)

## Step 3 — Keep it awake (cron-job.org)
1. Go to **https://cron-job.org** → sign up (free).
2. **Create cronjob** → URL = `https://YOUR-SERVER.onrender.com/api/tick` → run **every 5 minutes**.
3. Save. This wakes the server to send due reminders even when nobody has the app open.

## Step 4 — Point the app at it
On any device, open Papa's Almanac → **Sign in** → expand **"Sync server address (advanced)"**
→ paste your `https://…onrender.com` address → **Create account** (first time) or **Log in**.

Do that on his Mac, iPhone and iPad with the **same email** → one synced planner everywhere,
with reminders that arrive even when the app is closed. 🎉

---

### Run locally (for testing)
```
npm install
node server.mjs        # uses a local file, no Turso needed
```
Server runs on `http://localhost:4400`.

### Notes
- Passwords are stored hashed (scrypt) — never in plain text.
- `/api/health` status, `/api/tick` runs the reminder check (used by the cron).
- To use a paid always-on plan later, change `plan: free` in `render.yaml` and skip Step 3.
