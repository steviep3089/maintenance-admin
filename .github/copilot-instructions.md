# Copilot instructions — maintenance-admin

Purpose: Provide concise, actionable guidance for AI coding agents working on this repo.

- **Big picture**: Single-page React admin portal built with Vite. All UI lives in `src/` (notably `src/App.jsx`). Auth and DB access use Supabase via `src/supabaseClient.js`.

- **Key runtime flows**:
  - Authentication: `src/App.jsx` calls `supabase.auth.getSession()` and subscribes to `onAuthStateChange`. Password recovery triggers `view === "reset"` when the URL/hash contains `type=recovery` or event `PASSWORD_RECOVERY` occurs.
  - Authorization: user role is read from the `user_roles` table (`user_id` → `role`) to gate the admin UI.
  - Defects data: `defects` table is the primary dataset; `defect_activity` stores logs. Media uploads go to Supabase storage bucket `repair-photos` and are exposed via `createSignedUrl`.

- **Where to change the "remember password" behaviour**:
  - File: `src/App.jsx`, component `LoginPage`.
  - Keys: `localStorage` keys used are `admin_savedEmail` and `admin_savedPassword`.
  - Functions/places: `useEffect` that reads the saved values, `rememberLogin()` which writes/removes keys, and the `remember` checkbox state.
  - Safe change: remove storing plaintext passwords. To remove the feature delete the `remember` state and checkbox, drop `admin_savedPassword` reads/writes, and keep only `admin_savedEmail` if you want to remember email.

- **Data and DB tables to be aware of**:
  - `defects` — main rows displayed in `DefectsPage`.
  - `defect_activity` — recent activity shown per-defect.
  - `user_roles` — maps `user_id` → `role` (`admin` required for the portal).
  - Storage bucket: `repair-photos` (uploads + `createSignedUrl`).

- **Project conventions & patterns**:
  - Small, single-file React components (primarily `src/App.jsx`) rather than many split components.
  - Inline styles used widely; small CSS file for layout in `src/App.css`.
  - No client-side router — app view switching is performed by component state (`view` variable in `App`).
  - Minimal external deps: Supabase (`@supabase/supabase-js`) and React/Vite.

- **Dev / build / test commands** (from `package.json`):
  - Dev: `npm run dev` (starts Vite HMR)
  - Build: `npm run build`
  - Preview: `npm run preview`
  - Lint: `npm run lint`

- **Integration gotchas**:
  - Supabase client config lives in `src/supabaseClient.js` — do not commit service_role keys or secrets.
  - Password recovery: `supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })` — ensure your site origin is allowed in Supabase auth settings.
  - File uploads: code uploads then immediately requests `createSignedUrl`; signed URLs are used in the UI.

- **When making changes**:
  - Run `npm run dev` to test UI interactions; open console to see auth event logs (the app logs `Auth event:` in console).
  - If editing auth flows, ensure `onAuthStateChange` handling still sets correct `view` and calls `loadRoleForSession`.

If anything here is unclear or you want the repo to remove the "remember password" feature now, tell me and I will apply the change in `src/App.jsx` (recommended: stop storing `admin_savedPassword` and remove the checkbox).
