import type { SupabaseClient } from "@supabase/supabase-js";

/** Ключ `welcome_text`, value: `{"text":"..."}` или JSON-строка с полным текстом. */
export async function getWelcomeText(
  supabase: SupabaseClient,
  fallback: string
): Promise<string> {
  const { data, error } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "welcome_text")
    .maybeSingle();

  if (error || !data?.value) return fallback;

  const raw = data.value as unknown;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "text" in raw) {
    const t = (raw as { text?: unknown }).text;
    if (typeof t === "string" && t.trim()) return t;
  }
  return fallback;
}

/** Цены услуг (инфо), не путать с предоплатой записи. Ключ `service_prices`: `{ "uvt": 10, ... }`. */
const DEFAULT_SERVICE_PRICES: Record<string, number> = {
  uvt: 10,
  dry_needle: 10,
  magnet_hi: 10,
  magnet_vacuum: 10,
  percussion: 10,
  vacuum_gradient: 10,
  soft_manual: 10,
  hijama: 10,
  massage: 10,
};

export function defaultServicePrices(): Record<string, number> {
  return { ...DEFAULT_SERVICE_PRICES };
}

export async function getServicePrices(
  supabase: SupabaseClient
): Promise<Record<string, number>> {
  const merged = { ...DEFAULT_SERVICE_PRICES };
  const { data, error } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "service_prices")
    .maybeSingle();

  if (error || !data?.value || typeof data.value !== "object" || data.value === null) {
    return merged;
  }

  const o = data.value as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      merged[k] = Math.round(v);
    }
  }
  return merged;
}

export async function setServicePrice(
  supabase: SupabaseClient,
  serviceId: string,
  priceRub: number
): Promise<void> {
  const current = await getServicePrices(supabase);
  current[serviceId] = Math.max(0, Math.round(priceRub));
  const { error } = await supabase.from("settings").upsert(
    {
      key: "service_prices",
      value: current,
    },
    { onConflict: "key" }
  );
  if (error) throw error;
}
