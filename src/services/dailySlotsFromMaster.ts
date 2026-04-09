import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../config/env.js";
import type { BlockedInterval } from "./masterAvailabilityRepo.js";
import { getMasterAvailabilityForDate } from "./masterAvailabilityRepo.js";
import { insertSlot, deleteSlotIfFree } from "./slotsRepo.js";
import {
  irkutskDayUtcRange,
  parseIrkutskStartEnd,
} from "../util/time.js";

export const DEFAULT_MASTER_DAY_START = "10:00";
export const DEFAULT_MASTER_DAY_END = "21:00";
export const MASTER_SLOT_DURATION_MIN = 60;

/** Секунды с эпохи — как в autoSlots */
export function slotTimeKey(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function hhmmToMinutes(hhmm: string): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minutesToHhmm(min: number): string {
  const h = Math.floor(min / 60);
  const mm = min % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function intervalOverlaps(
  a0: number,
  a1: number,
  b0: number,
  b1: number
): boolean {
  return Math.max(a0, b0) < Math.min(a1, b1);
}

/**
 * Список времён начала слотов (ЧЧ:ММ) в пределах [start, end), длительность durationMin,
 * без пересечения с blocked.
 */
export function computeDesiredSlotStartsHhmm(
  startHhmm: string,
  endHhmm: string,
  blocked: BlockedInterval[],
  durationMin: number
): string[] {
  const startMin = hhmmToMinutes(startHhmm);
  const endMin = hhmmToMinutes(endHhmm);
  const blocks = blocked
    .map((b) => ({
      a: hhmmToMinutes(b.start),
      b: hhmmToMinutes(b.end),
    }))
    .filter((x) => x.b > x.a);

  const out: string[] = [];
  for (let t = startMin; t + durationMin <= endMin; t += durationMin) {
    const t1 = t + durationMin;
    let hit = false;
    for (const bl of blocks) {
      if (intervalOverlaps(t, t1, bl.a, bl.b)) {
        hit = true;
        break;
      }
    }
    if (!hit) out.push(minutesToHhmm(t));
  }
  return out;
}

export async function getEffectiveMasterDayConfig(
  supabase: SupabaseClient,
  ymd: string,
  closureSet: Set<string>
): Promise<{
  isDayOff: boolean;
  startHhmm: string;
  endHhmm: string;
  blocked: BlockedInterval[];
}> {
  if (closureSet.has(ymd)) {
    return {
      isDayOff: true,
      startHhmm: DEFAULT_MASTER_DAY_START,
      endHhmm: DEFAULT_MASTER_DAY_END,
      blocked: [],
    };
  }
  const row = await getMasterAvailabilityForDate(supabase, ymd);
  if (row && !row.is_available) {
    return {
      isDayOff: true,
      startHhmm: row.start_time,
      endHhmm: row.end_time,
      blocked: row.blocked_slots,
    };
  }
  if (!row) {
    return {
      isDayOff: false,
      startHhmm: DEFAULT_MASTER_DAY_START,
      endHhmm: DEFAULT_MASTER_DAY_END,
      blocked: [],
    };
  }
  return {
    isDayOff: false,
    startHhmm: row.start_time,
    endHhmm: row.end_time,
    blocked: row.blocked_slots,
  };
}

function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; message?: string };
  if (err.code === "23505") return true;
  const m = String(err.message ?? "");
  return m.includes("duplicate key") || m.includes("unique constraint");
}

/**
 * Добавляет недостающие слоты по графику (идемпотентно). Не удаляет лишние.
 */
export async function ensureMissingSlotsForDay(
  supabase: SupabaseClient,
  env: Env,
  ymd: string,
  nowIso: string,
  closureSet: Set<string>,
  haveKeys: Set<number>
): Promise<void> {
  const cfg = await getEffectiveMasterDayConfig(supabase, ymd, closureSet);
  if (cfg.isDayOff) return;

  const starts = computeDesiredSlotStartsHhmm(
    cfg.startHhmm,
    cfg.endHhmm,
    cfg.blocked,
    MASTER_SLOT_DURATION_MIN
  );

  for (const hhmm of starts) {
    const { starts_at, ends_at } = parseIrkutskStartEnd(
      ymd,
      hhmm,
      MASTER_SLOT_DURATION_MIN
    );
    if (starts_at < nowIso) continue;
    const key = slotTimeKey(starts_at);
    if (haveKeys.has(key)) continue;
    try {
      const row = await insertSlot(supabase, { starts_at, ends_at });
      haveKeys.add(slotTimeKey(row.starts_at));
    } catch (e) {
      if (isUniqueViolation(e)) {
        haveKeys.add(key);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Полная пересборка слотов дня по графику: свободные лишние удаляются,
 * занятые/с записью не трогаем.
 */
export async function regenerateSlotsForDay(
  supabase: SupabaseClient,
  _env: Env,
  ymd: string,
  closureSet: Set<string>
): Promise<void> {
  const cfg = await getEffectiveMasterDayConfig(supabase, ymd, closureSet);
  const { fromInclusive, toExclusive } = irkutskDayUtcRange(ymd);

  const { data: slotsInDay, error: q1 } = await supabase
    .from("slots")
    .select("id, starts_at")
    .gte("starts_at", fromInclusive)
    .lt("starts_at", toExclusive);

  if (q1) throw q1;
  const slotRows = (slotsInDay ?? []) as { id: string; starts_at: string }[];

  const desiredHhmm = cfg.isDayOff
    ? []
    : computeDesiredSlotStartsHhmm(
        cfg.startHhmm,
        cfg.endHhmm,
        cfg.blocked,
        MASTER_SLOT_DURATION_MIN
      );

  const desiredKeys = new Set<number>();
  const desiredStarts: { starts_at: string; ends_at: string }[] = [];
  for (const hhmm of desiredHhmm) {
    const se = parseIrkutskStartEnd(ymd, hhmm, MASTER_SLOT_DURATION_MIN);
    desiredStarts.push(se);
    desiredKeys.add(slotTimeKey(se.starts_at));
  }

  for (const s of slotRows) {
    const k = slotTimeKey(s.starts_at);
    if (desiredKeys.has(k)) continue;
    await deleteSlotIfFree(supabase, s.id);
  }

  const nowIso = new Date().toISOString();
  for (const se of desiredStarts) {
    if (se.starts_at < nowIso) continue;
    try {
      await insertSlot(supabase, {
        starts_at: se.starts_at,
        ends_at: se.ends_at,
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
}
