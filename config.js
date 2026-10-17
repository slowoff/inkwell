// Inkwell sync settings (Supabase project "inkwell", region Zurich).
// The anon key is meant to be public: row-level security keeps each account's notes private.
window.INKWELL_CONFIG = {
  SUPABASE_URL: "https://pubaedzrgrkjifmiqiew.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB1YmFlZHpyZ3JramlmbWlxaWV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NjY1NTMsImV4cCI6MjEwNzU0MjU1M30.6Poy7oNGlK4ZjJxpCCRz3e9Klu0wydOQY10eMbk7Qms",
  // Import from OneNote: Application (client) ID of the Microsoft app registration (can also be pasted in the app)
  ONENOTE_CLIENT_ID: "",
  // Sign in with Google (1.34); public by design (the secret stays in the Supabase function secrets)
  GOOGLE_CLIENT_ID: "912799258255-lhp0g7tldbe57nmqt8b3olhpep20s19a.apps.googleusercontent.com"
};
