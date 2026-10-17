// Inkwell sync settings (Supabase project "inkwell", region Zurich).
// The key (since 1.35 the "publishable" key; the old anon key stops working at the end of 2026) is meant to be public: row-level security keeps each account's notes private.
window.INKWELL_CONFIG = {
  SUPABASE_URL: "https://pubaedzrgrkjifmiqiew.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Wf2ZJlMsIHfVzaPZCu44fQ_5Ue4d8G5",
  // Import from OneNote: Application (client) ID of the Microsoft app registration (can also be pasted in the app)
  ONENOTE_CLIENT_ID: "",
  // Sign in with Google (1.34); public by design (the secret stays in the Supabase function secrets)
  GOOGLE_CLIENT_ID: "912799258255-lhp0g7tldbe57nmqt8b3olhpep20s19a.apps.googleusercontent.com"
};
