import type { SupabaseClient } from "@supabase/supabase-js";

export interface BlockedInterval {
  start: string;
  end: string;
}

export interface MasterAvailabilityRow {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  is_available: boolean;
  blocked_slots: BlockedInterval[];
  created_at: string;
  updated_at: string;
}

/** PostgreSQL time → «ЧЧ:ММ» */
function normalizePgTime(t: string): string {
  const s = t.slice(0, 5);
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "10:00";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function parseBlocked(raw: unknown): BlockedInterval[] {
  if (!Array.isArray(raw)) return [];
  const out: BlockedInterval[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as { start?: unknown; end?: unknown };
    if (typeof o.start === "string" && typeof o.end === "string") {
      out.push({ start: o.start.slice(0, 5), end: o.end.slice(0, 5) });
    }
  }
  return out;
}

export async function getMasterAvailabilityForDate(
  supabase: SupabaseClient,
  ymd: string
): Promise<MasterAvailabilityRow | null> {
  const { data, error } = await supabase
    .from("master_availability")
    .select("*")
    .eq("date", ymd)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    id: String(r.id),
    date: String(r.date),
    start_time: normalizePgTime(String(r.start_time)),
    end_time: normalizePgTime(String(r.end_time)),
    is_available: Boolean(r.is_available),
    blocked_slots: parseBlocked(r.blocked_slots),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export async function upsertMasterAvailability(
  supabase: SupabaseClient,
  row: {
    date: string;
    start_time: string;
    end_time: string;
    is_available: boolean;
    blocked_slots: BlockedInterval[];
  }
): Promise<void> {
  const { error } = await supabase.from("master_availability").upsert(
    {
      date: row.date,
      start_time: row.start_time,
      end_time: row.end_time,
      is_available: row.is_available,
      blocked_slots: row.blocked_slots,
    },
    { onConflict: "date" }
  );
  if (error) throw error;
}

export async function deleteMasterAvailabilityForDate(
  supabase: SupabaseClient,
  ymd: string
): Promise<void> {
  const { error } = await supabase
    .from("master_availability")
    .delete()
    .eq("date", ymd);
  if (error) throw error;
}
