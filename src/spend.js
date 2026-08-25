import { monthKey } from "./config.js";

export const VENDORS = Object.freeze(["apify", "waterfall", "verifier"]);

export function emptyVendorSpend() {
  return { apify_cents: 0, waterfall_cents: 0, verifier_cents: 0 };
}

export function totalCents(row) {
  return (
    Number(row?.apify_cents || 0) +
    Number(row?.waterfall_cents || 0) +
    Number(row?.verifier_cents || 0)
  );
}

export async function loadSpend(supabase, key = monthKey()) {
  const { data, error } = await supabase.rpc("sg_pipeline_spend_state", { p_month: key });
  if (error) throw new Error(`spend state: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    monthKey: row?.month_key || key,
    apify_cents: Number(row?.apify_cents || 0),
    waterfall_cents: Number(row?.waterfall_cents || 0),
    verifier_cents: Number(row?.verifier_cents || 0),
    spendCents: totalCents(row),
  };
}

export async function addSpend(supabase, vendor, cents, key = monthKey()) {
  if (!cents || cents <= 0) return loadSpend(supabase, key);
  const { data, error } = await supabase.rpc("sg_pipeline_add_spend", {
    p_month: key,
    p_vendor: vendor,
    p_cents: cents,
  });
  if (error) throw new Error(`spend add: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    monthKey: key,
    apify_cents: Number(row?.apify_cents || 0),
    waterfall_cents: Number(row?.waterfall_cents || 0),
    verifier_cents: Number(row?.verifier_cents || 0),
    spendCents: totalCents(row),
  };
}

export function wouldExceedCap(spendCents, additionalCents, capCents) {
  return spendCents + additionalCents > capCents;
}

export function usdToCents(usd) {
  return Math.round(Number(usd || 0) * 100 * 1000) / 1000;
}
