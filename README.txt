INKWELL

A notes app for the iPad (a OneNote replacement) that runs as a home-screen
web app: notebooks > sections > pages, typed text and Apple Pencil ink on an
infinite canvas, PDF/Word/picture import, search, Ask Claude, and sync
between devices.

Live app: https://slowoff.github.io/inkwell/
Current version: see VERSION in sw.js.

How it is built:
- One plain HTML/CSS/JS app, no build step: index.html, app.css, app.js,
  config.js, sw.js (offline cache). Libraries are bundled in lib/.
- Notes are stored on the device first (IndexedDB) and synced through
  Supabase (table "docs", each account only sees its own rows).
- Sign in is with Google only. Pictures and a copy of all notes
  ("Inkwell notes.json") go to the person's own Google Drive, folder
  "Inkwell pictures". Without signing in, everything stays on the device.
- Hosted on GitHub Pages from the main branch.

The code is public, your notes are not: they sit in the Supabase project,
protected by your login, and in your own Google Drive.

================================================================
FIRST-TIME SETUP (only needed for a new copy of Inkwell)
================================================================

You need a computer for steps 1 to 4. Step 5 is on the iPad.

----------------------------------------------------------------
1. SYNC DATABASE (Supabase, free)
----------------------------------------------------------------
a) supabase.com -> New project. Name: inkwell. Region: Central EU
   (Zurich) or Frankfurt. Pick a strong database password. Create.
b) SQL Editor -> New query. Paste and Run, in this order:
     setup.sql
     supabase/migrations/20261017_limits_and_files.sql
     supabase/migrations/20261018_gdrive.sql
     supabase/migrations/20261018_guard_fix.sql
     supabase/migrations/20261025_docs_put.sql
   Each should say "Success".
c) Project Settings -> API Keys: copy the "publishable" key
   (starts with sb_publishable_). Project Settings -> Data API:
   copy the Project URL. Paste both into config.js
   (SUPABASE_URL and SUPABASE_ANON_KEY). The old "anon" keys stop
   working at the end of 2026, so do not use them.
d) Authentication -> Sign In / Providers: turn OFF "Allow new users
   to sign up". Accounts are made by the Google sign-in instead.

----------------------------------------------------------------
2. GOOGLE SIGN-IN AND DRIVE
----------------------------------------------------------------
a) console.cloud.google.com -> new project "Inkwell".
   Enable the Google Drive API.
b) Google Auth Platform -> Branding: app name Inkwell, privacy policy
   link https://YOUR-GITHUB-NAME.github.io/inkwell/privacy.html.
   Audience: External, then "Publish app" (In production).
   Data access: scopes drive.file, openid, email.
c) Clients -> Create client -> Web application.
   Authorized JavaScript origin: https://YOUR-GITHUB-NAME.github.io
   Authorized redirect URI:      https://YOUR-GITHUB-NAME.github.io/inkwell/
   Copy the Client ID into config.js (GOOGLE_CLIENT_ID).
   Keep the Client secret for step 3.

----------------------------------------------------------------
3. SERVER FUNCTIONS (Supabase Edge Functions)
----------------------------------------------------------------
a) Deploy both functions from supabase/functions/ with
   "Verify JWT" turned OFF (they check the user themselves):
     files  - Google sign-in, pictures in Google Drive
     ask    - Ask Claude (optional)
b) Edge Functions -> Secrets:
     GOOGLE_CLIENT_ID       the Client ID from step 2
     GOOGLE_CLIENT_SECRET   the Client secret from step 2
   For Ask Claude (optional, billed separately by Anthropic):
     ANTHROPIC_API_KEY      from console.anthropic.com
     ASK_ALLOWED_EMAILS     comma-separated emails allowed to use it
     ASK_MODEL / ASK_FAST_MODEL   optional model overrides

----------------------------------------------------------------
4. HOSTING (GitHub Pages, free)
----------------------------------------------------------------
a) github.com -> New repository "inkwell", Public. Upload ALL files and
   folders from this folder (index.html, app.js, lib, icons, .github ...).
b) Settings -> Pages -> Source: "Deploy from a branch", branch main,
   folder / (root). Save. After 1-2 minutes the app is at
   https://YOUR-GITHUB-NAME.github.io/inkwell/
c) In .github/workflows/keepalive.yml put your own Supabase URL and
   publishable key. It pings the database every 3 days so the free
   project never pauses.

----------------------------------------------------------------
5. ON THE IPAD
----------------------------------------------------------------
a) Open the link in Safari.
b) Share button -> Add to Home Screen -> Add.
c) Open Inkwell from the home screen.
d) Optional: tap the gear (top left) -> Sign in with Google.
Sign in with the same Google account on your phone or PC and the
notes sync. Each Google account keeps its own notes on a device.

================================================================
OPTIONAL: IMPORT FROM ONENOTE
================================================================
Needs a Microsoft app registration (Entra admin center -> App
registrations): personal + work accounts, platform "Single-page
application", redirect https://YOUR-GITHUB-NAME.github.io/inkwell/,
Microsoft Graph delegated permission Notes.Read. Put the Application
(client) ID in config.js (ONENOTE_CLIENT_ID) or paste it in the app:
Settings -> Your notes -> Import from OneNote (it has a step-by-step
guide).

================================================================
RELEASING A CHANGE
================================================================
1. Change the files.
2. Raise VERSION in sw.js. Without this, iPads keep the old cached
   version. Numbers are big.feature.fix:
     fix only          1.40 -> 1.40.1 -> 1.40.2
     new feature       1.40.2 -> 1.41
     big update        1.x -> 2.0 (redesign, new storage or sync)
3. Run the tests: tests/run.sh (headless Chromium with Playwright,
   fake Supabase and Google). They also run on GitHub on every push.
4. Commit and push to main. GitHub Pages redeploys in about a minute.
5. On the iPad: close Inkwell fully and open it again.

Database changes go in supabase/migrations/ as a new .sql file.
Old notes must keep working: if the data format changes, old data is
converted when it loads.

Files:
  index.html, app.css, app.js   the app
  config.js                     Supabase URL + key, Google and OneNote client IDs
  sw.js                         offline cache (VERSION)
  manifest.webmanifest, icons/  home-screen app
  privacy.html                  privacy page for the Google consent screen
  lib/                          pdf.js, pdf-lib, KaTeX, supabase-js, docx-preview
  setup.sql, supabase/          database setup, migrations, edge functions
  tests/                        browser tests
  .github/workflows/            tests on every push, Supabase keep-alive
