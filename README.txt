INKWELL - SETUP (about 15 minutes, once)

You need a computer for steps 1 and 2. Step 3 is on the iPad.

----------------------------------------------------------------
1. SYNC DATABASE (Supabase, free)
----------------------------------------------------------------
a) Go to supabase.com, sign up, click "New project".
   Name: inkwell. Pick a strong database password (you won't need it again).
   Region: Central EU (Zurich) or Frankfurt. Create.
b) Left menu: SQL Editor -> New query. Open setup.sql from this folder,
   paste everything, click Run. It should say "Success".
c) Left menu: Project Settings -> API Keys.
   Copy the "anon" "public" key. If you only see a "publishable" key,
   open the "Legacy API keys" tab and copy the anon key from there.
   Then: Project Settings -> Data API (or "API") -> copy the Project URL.
d) Open config.js in this folder with Notepad and paste both values
   between the quotes. Save.
e) Optional, makes sign-up simpler: Authentication -> Sign In / Providers
   -> Email -> turn off "Confirm email". Otherwise you click a link in an
   email once after creating your account.

Note: free Supabase projects pause after 7 days without any use.
If that happens, log in at supabase.com and click "Restore project".
Your notes stay on the iPad either way.

----------------------------------------------------------------
2. HOSTING (GitHub Pages, free)
----------------------------------------------------------------
a) Go to github.com, sign up, click "New repository".
   Name: inkwell. Public. Create.
b) Click "uploading an existing file". Drag ALL files and folders from
   this folder into the page (index.html, app.js, lib, icons, ...).
   Click "Commit changes".
c) Repository Settings -> Pages -> Source: "Deploy from a branch",
   Branch: main, folder: / (root). Save.
d) After 1-2 minutes your app is at:
   https://YOUR-GITHUB-NAME.github.io/inkwell/

The code is public, your notes are not: they sit in your private
Supabase project, protected by your login.

----------------------------------------------------------------
3. ON THE IPAD
----------------------------------------------------------------
a) Open the link in Safari.
b) Share button -> Add to Home Screen -> Add.
c) Open Inkwell from the home screen.
d) Tap the gear (top left) -> enter email and password ->
   Create account, then Sign in.
Do the same on your phone or PC with the same account and the
notes sync.

----------------------------------------------------------------
UPDATING LATER
----------------------------------------------------------------
Upload the changed files to the same GitHub repository (they replace
the old ones). Inkwell shows "A new version is ready - Reload".
