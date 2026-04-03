import type { SupabaseClient } from "@supabase/supabase-js";
import type { SlotRow } from "../db/types.js";

export async function listAvailableSlots(
  supabase: SupabaseClient,
  limit = 20
): Promise<SlotRow[]> {
  const now = new Date().toISOString();
  const { data: slots, error: qErr } = await supabase
    .from("slots")
    .select("*")
    .eq("is_published", true)
    .eq("is_booked", false)
    .gte("starts_at", now)
    .order("starts_at", { ascending: true })
    .limit(limit * 2);

  if (qErr) throw qErr;
  const list = (slots ?? []) as SlotRow[];

  const { data: pending, error: pErr } = await supabase
    .from("appointments")
    .select("slot_id")
    .eq("status", "pending_payment");

  if (pErr) throw pErr;
  const busy = new Set((pending ?? []).map((r: { slot_id: string }) => r.slot_id));

  return list.filter((s) => !busy.has(s.id)).slice(0, limit);
}

export async function getSlot(
  supabase: SupabaseClient,
  id: string
): Promise<SlotRow | null> {
  const { data, error } = await supabase
    .from("slots")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as SlotRow | null;
}

export async function insertSlot(
  supabase: SupabaseClient,
  row: Pick<SlotRow, "starts_at" | "ends_at"> & { is_published?: boolean }
): Promise<SlotRow> {
  const { data, error } = await supabase
    .from("slots")
    .insert({
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      is_published: row.is_published ?? true,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as SlotRow;
}

export async function setSlotPublished(
  supabase: SupabaseClient,
  id: string,
  isPublished: boolean
): Promise<void> {
  const { error } = await supabase
    .from("slots")
    .update({ is_published: isPublished })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteSlotIfFree(
  supabase: SupabaseClient,
  id: string
): Promise<{ ok: boolean; reason?: string }> {
  const { data: apt } = await supabase
    .from("appointments")
    .select("id, status")
    .eq("slot_id", id)
    .in("status", ["pending_payment", "confirmed"])
    .maybeSingle();

  if (apt) {
    return { ok: false, reason: "На слот есть активная запись" };
  }

  const { error } = await supabase.from("slots").delete().eq("id", id);
  if (error) throw error;
  return { ok: true };
}

export async function listSlotsAdmin(
  supabase: SupabaseClient,
  fromIso: string
): Promise<SlotRow[]> {
  const { data, error } = await supabase
    .from("slots")
    .select("*")
    .gte("starts_at", fromIso)
    .order("starts_at", { ascending: true })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as SlotRow[];
}
