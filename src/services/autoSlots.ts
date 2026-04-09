import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../config/env.js";
import { listClosureDays } from "./closureDaysRepo.js";
import {
  ensureMissingSlotsForDay,
  slotTimeKey,
} from "./dailySlotsFromMaster.js";
import {
  addIrkutskCalendarDaysYmd,
  irkutskTodayYmd,
} from "../util/time.js";

/**
 * Для каждого дня в горизонте создаёт недостающие слоты по графику мастера
 * (по умолчанию 10:00–21:00 Иркутск, шаг 60 мин, учёт master_availability и closure_days).
 */
export async function ensureStandardDailySlots(
  supabase: SupabaseClient,
  env: Env
): Promise<void> {
  if (!env.AUTO_SLOTS_ENABLED) return;

  const now = new Date().toISOString();
  const todayYmd = irkutskTodayYmd();
  const horizon = env.AUTO_SLOTS_HORIZON_DAYS;

  let closure = new Set<string>();
  try {
    closure = new Set(await listClosureDays(supabase));
  } catch {
    /* closure_days ещё нет */
  }

  const lastDay = addIrkutskCalendarDaysYmd(todayYmd, horizon - 1);
  const upperYmd = addIrkutskCalendarDaysYmd(lastDay, 1);
  const upperStart = `${upperYmd}T00:00:00+08:00`;
  const upperExclusive = new Date(
    new Date(upperStart).getTime()
  ).toISOString();

  const { data: existingRows, error: qErr } = await supabase
    .from("slots")
    .select("starts_at")
    .gte("starts_at", now)
    .lt("starts_at", upperExclusive);

  if (qErr) throw qErr;
  const have = new Set(
    (existingRows ?? []).map((r: { starts_at: string }) =>
      slotTimeKey(r.starts_at)
    )
  );

  for (let d = 0; d < horizon; d++) {
    const ymd = addIrkutskCalendarDaysYmd(todayYmd, d);
    await ensureMissingSlotsForDay(supabase, env, ymd, now, closure, have);
  }
}
