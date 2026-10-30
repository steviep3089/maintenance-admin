// src/supabaseClient.js
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://zebksrihswwwlejdiboq.supabase.co";
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Browser bundles must only ever hold a publishable key (sb_publishable_...).
if (!supabasePublishableKey || !supabasePublishableKey.startsWith("sb_publishable_")) {
  throw new Error(
    "VITE_SUPABASE_PUBLISHABLE_KEY must be set to a Supabase publishable key (sb_publishable_...)."
  );
}

const SUPABASE_PROJECT_REF = supabaseUrl.split("//")[1]?.split(".")[0] || "";
export const SUPABASE_STORAGE_KEY = `sb-${SUPABASE_PROJECT_REF}-auth-token`;

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    storageKey: SUPABASE_STORAGE_KEY,
  },
});