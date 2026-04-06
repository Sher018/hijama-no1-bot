import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceById } from "../bot/content/servicesCatalog.js";
import { getServicePrices } from "./settingsRepo.js";
import { parseAppointmentServiceId } from "./appointmentNotes.js";

/**
 * Одна строка для сообщений об оплате/подтверждении: название процедуры и цена на месте.
 * Если услуга не выбрана — null (строку не показываем).
 */
export async function formatSelectedProcedureLine(
  supabase: SupabaseClient,
  notes: string | null
): Promise<string | null> {
  const sid = parseAppointmentServiceId(notes);
  if (!sid) return null;
  const s = getServiceById(sid);
  if (!s) return null;
  const prices = await getServicePrices(supabase);
  const price = prices[s.id] ?? 10;
  return `Процедура: ${s.title} — ${price} ₽ (на месте).`;
}
