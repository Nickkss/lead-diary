# Lead Diary

A follow-up tracker for leads that come in from ads on WhatsApp. It works on an iPhone (add it to the Home Screen) and on a Mac.

- **Today:** missed, due and undated follow-ups, ordered by priority
- **Leads:** each lead keeps its stage, priority, requirements and the full history of every conversation
- **Voice:** tap the mic, speak the update, and AI turns it into a clean note, a stage and the next follow-up date
- **Reminders:** phone notifications from the app itself, plus Google Calendar events
- **Dashboard:** charts, a breakdown by category, and an AI review
- **Backup:** export to Excel, and a full backup file you can restore
- **Team:** the admin creates logins. Everyone sees all leads and can add updates. Members change only their own leads and can't delete leads. Every update and change shows who made it.

Your data stays on your own server, in one SQLite file inside a Docker volume.

---

## Install on the VPS (Hostinger)

1. Open hPanel, go to **VPS**, then **Browser terminal**. You can also connect with SSH.
2. Paste this line and press Enter:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Nickkss/lead-diary/main/install.sh | sudo bash
   ```

3. Answer the two questions:
   - **Domain:** for example `leads.yourcompany.com`. First add an **A record** for it that points to your VPS IP address. To use a free address for now, press Enter.
   - **Anthropic API key:** this turns on the AI features. You can add it later.
4. At the end the installer shows your **app address** and a **6-digit setup code**. Open the address and enter the code, then choose your password.

The installer works out how to set up HTTPS:
- **Ports 80/443 are free:** it starts its own HTTPS server (Caddy) and gets a certificate automatically.
- **The server already runs nginx** (for example, for other websites): it adds a site for Lead Diary and gets a certificate with certbot.
- **Another program uses those ports:** it runs the app on `127.0.0.1:3010` and tells you to point that program at it.

### Put it on your iPhone

1. Open your app address in **Safari** and sign in.
2. Tap **Share**, then **Add to Home Screen**.
3. Open Lead Diary from the new icon. Go to **Settings**, then **Phone notifications**, then **Turn on**. This needs iOS 16.4 or later.

On a Mac, in Safari choose **File**, then **Add to Dock**.

---

## Settings in `/opt/lead-diary/.env`

| Setting | What it does |
|---|---|
| `DOMAIN`, `PUBLIC_URL` | The app address |
| `ANTHROPIC_API_KEY` | Turns on AI. Create a key at console.anthropic.com, under **API keys**. |
| `AI_MODEL` | Which Claude model to use. `claude-haiku-5-5` is low cost. `claude-opus-5-5` gives the best answers but costs much more. The installer asks you which one you want. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Calendar (see the next section) |
| `TZ` | Time zone for reminders. The default is `Asia/Kolkata`. |

After you change anything, apply it with:

```bash
cd /opt/lead-diary && sudo bash update.sh
```

---

## Google Calendar

This is a one-time setup, about 10 minutes.

1. Go to <https://console.cloud.google.com> and create a project called **Lead Diary**.
2. Turn on the Calendar API: open **APIs & Services**, then **Library**, search **Google Calendar API**, and click **Enable**.
3. Set up the sign-in screen: open **Google Auth Platform** (it may be called **OAuth consent screen**), click **Get started**, and fill it in:
   - App name: `Lead Diary`
   - Your email
   - Audience: **External**
4. Under **Audience**, click **Publish app** so it moves to **In production**.
   - If you skip this, Google disconnects the calendar every 7 days.
   - Google shows an "unverified app" warning when you connect. That is fine for your own app: click **Advanced**, then **Go to Lead Diary**.
5. Create the login keys: go to **Clients**, click **Create client**, choose **Web application**, and under **Authorized redirect URIs** add:

   ```
   https://YOUR-DOMAIN/api/google/callback
   ```

6. Copy the **Client ID** and **Client secret** into `.env`, then run `sudo bash update.sh`.
7. In the app, open **Settings**, then **Google Calendar**, then **Connect**.

From then on, the app keeps your calendar in step with your leads:
- every open lead with a follow-up date gets an event, with the reminder time you chose;
- the event moves when you change the date;
- the event is deleted when the deal is won or lost, or when you delete the lead.

---

## Everyday commands (on the server)

```bash
cd /opt/lead-diary
sudo bash update.sh                                         # get the latest version / apply .env changes
docker compose logs -f app                                  # see what the app is doing
docker compose exec app node server/reset-password.js <username> "new-password"   # forgot a password
```

**Backups:** in the app, open **Settings**, then **Backup**. **Download** gives you the full backup file, and **Export** gives you an Excel file. To move to a new server, install there, then use **Restore from a backup file**.

---

## Developing locally

```bash
npm install
DATA_DIR=./data PORT=3000 node server/server.js
```

The page is `public/index.html`. `public/runtime.js` connects it to the server. The server is in `server/`.
