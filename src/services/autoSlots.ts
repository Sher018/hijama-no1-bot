import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../config/env.js";
import { listClosureDays } from "./closureDaysRepo.js";
import { insertSlot } from "./slotsRepo.js";
import {
  addIrkutskCalendarDaysYmd,
  irkutskDayUtcRange,
  irkutskTodayYmd,
  parseIrkutskStartEnd,
} from "../util/time.js";

/** Фиксированные окна записи по Иркутску (совпадает с MAX_SLOTS_PER_DAY=5). */
export const AUTO_SLOT_TIMES_HHMM = [
  "10:00",
  "13:00",
  "15:00",
  "17:00",
  "19:00",
] as const;

const AUTO_SLOT_DURATION_MIN = 60;

/**
 * Для каждого дня в горизонте создаёт недостающие слоты (идемпотентно по starts_at).
 * Пропускает дни из closure_days и слоты в прошлом.
 */
export async function ensureStandardDailySlots(
  supabase: SupabaseClient,
  env: Env
): Promise<void> {
  if (!env.AUTO_SLOTS_ENABLED) return;

  const now = new Date().toISOString();
  const todayYmd = irkutskTodayYmd();
  const horizon = env.AUTO_SLOTS_HORIZON_DAYS;
  const lastDay = addIrkutskCalendarDaysYmd(todayYmd, horizon - 1);
  const upperExclusive = irkutskDayUtcRange(
    addIrkutskCalendarDaysYmd(lastDay, 1)
  ).fromInclusive;

  let closure = new Set<string>();
  try {
    closure = new Set(await listClosureDays(supabase));
  } catch {
    /* closure_days ещё нет */
  }

  const { data: existingRows, error: qErr } = await supabase
    .from("slots")
    .select("starts_at")
    .gte("starts_at", now)
    .lt("starts_at", upperExclusive);

  if (qErr) throw qErr;
  const have = new Set(
    (existingRows ?? []).map((r: { starts_at: string }) => r.starts_at)
  );

  for (let d = 0; d < horizon; d++) {
    const ymd = addIrkutskCalendarDaysYmd(todayYmd, d);
    if (closure.has(ymd)) continue;

    for (const hhmm of AUTO_SLOT_TIMES_HHMM) {
      const { starts_at, ends_at } = parseIrkutskStartEnd(
        ymd,
        hhmm,
        AUTO_SLOT_DURATION_MIN
      );
      if (starts_at < now) continue;
      if (have.has(starts_at)) continue;
      const row = await insertSlot(supabase, { starts_at, ends_at });
      have.add(row.starts_at);
    }
  }
}
