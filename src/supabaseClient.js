// src/supabaseClient.js
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://zebksrihswwwlejdiboq.supabase.co";
const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InplYmtzcmloc3d3d2xlamRpYm9xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUyODY2MDAsImV4cCI6MjA4MDg2MjYwMH0.yBjz_NXvkpiKNH-eYvzPrHuEEqXyVCRdx1FX-L3gBvE";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
