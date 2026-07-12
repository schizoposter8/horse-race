import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error(
    "Missing Supabase configuration. Set VITE_SUPABASE_URL and " +
    "VITE_SUPABASE_ANON_KEY in your environment (see README step 2)."
  );
}

export const supabase = createClient(url || "http://localhost", anonKey || "missing");

/** Write a JSON value to a key (upsert). Returns true on success. */
export async function sSet(key, val) {
  try {
    const { error } = await supabase
      .from("kv")
      .upsert({ key, value: val, updated_at: new Date().toISOString() });
    if (error) throw error;
    return true;
  } catch (e) {
    console.error("sSet failed:", e.message || e);
    return false;
  }
}

/** Read a JSON value by key. Returns the value, or null if missing. */
export async function sGet(key) {
  try {
    const { data, error } = await supabase
      .from("kv")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error) throw error;
    return data ? data.value : null;
  } catch (e) {
    console.error("sGet failed:", e.message || e);
    return null;
  }
}

/** List keys that start with a prefix. Returns an array of key strings. */
export async function sList(prefix) {
  try {
    const { data, error } = await supabase
      .from("kv")
      .select("key")
      .like("key", `${prefix}%`);
    if (error) throw error;
    return (data || []).map((r) => r.key);
  } catch (e) {
    console.error("sList failed:", e.message || e);
    return [];
  }
}

/** Load all players in a room, sorted by join time. */
export async function loadRoster(code) {
  try {
    const { data, error } = await supabase
      .from("kv")
      .select("key, value")
      .like("key", `hr:${code}:p:%`);
    if (error) throw error;
    return (data || [])
      .map((r) => ({ id: r.key.split(":").pop(), ...r.value }))
      .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  } catch (e) {
    console.error("loadRoster failed:", e.message || e);
    return [];
  }
}

/** Subscribe to realtime changes on a single key. Returns unsubscribe fn. */
export function subscribeKey(key, onChange) {
  const ch = supabase
    .channel(`kv-${key}-${Math.random().toString(36).slice(2)}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "kv", filter: `key=eq.${key}` },
      (payload) => onChange(payload.new ? payload.new.value : null)
    )
    .subscribe();
  return () => supabase.removeChannel(ch);
}

/** Subscribe to changes on any key with a prefix (player roster). */
export function subscribePrefix(prefix, onChange) {
  const ch = supabase
    .channel(`kvp-${prefix}-${Math.random().toString(36).slice(2)}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "kv" },
      (payload) => {
        const k = payload.new?.key || payload.old?.key;
        if (k && k.startsWith(prefix)) onChange();
      }
    )
    .subscribe();
  return () => supabase.removeChannel(ch);
}
