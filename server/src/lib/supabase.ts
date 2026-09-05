import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const url = process.env.SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  console.warn("SUPABASE_URL or SERVICE_ROLE_KEY missing");
}

export const supabase = createClient(url || "http://localhost", serviceKey || "key", {
  auth: { persistSession: false },
});
