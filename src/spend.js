import { monthKey } from "./config.js";

export async function loadSpend(supabase, key = monthKey()) {
  const { data, error } = await supabase.rpc("sg_engager_spend_state", { p_month: key });
  if (error) throw new Error(`spend state: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    monthKey: row?.month_key || key,
    spendCents: Number(row?.spend_cents || 0),
  };
}

export async function addSpend(supabase, cents, key = monthKey()) {
  if (!cents || cents <= 0) return loadSpend(supabase, key);
  const { data, error } = await supabase.rpc("sg_engager_add_spend", {
    p_month: key,
    p_cents: cents,
  });
  if (error) throw new Error(`spend add: ${error.message}`);
  return {
    monthKey: key,
    spendCents: Number(data || 0),
  };
}

export function wouldExceedCap(spendCents, additionalCents, capCents) {
  return spendCents + additionalCents > capCents;
}
