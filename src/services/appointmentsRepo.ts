import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppointmentRow, AppointmentWithRelations } from "../db/types.js";
import { irkutskCurrentMonthStartUtcIso } from "../util/time.js";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Удаляет записи и слоты, у которых начало сеанса раньше первого числа текущего месяца (Иркутск).
 * Вызывается планировщиком (например, после смены месяца данные прошлых месяцев уходят из БД).
 */
export async function purgeOldSlotsAndAppointments(
  supabase: SupabaseClient
): Promise<{ deletedAppointments: number; deletedSlots: number }> {
  const cutoff = irkutskCurrentMonthStartUtcIso();

  const { data: oldSlots, error: qErr } = await supabase
    .from("slots")
    .select("id")
    .lt("starts_at", cutoff);
  if (qErr) throw qErr;
  const slotIds = (oldSlots ?? []).map((r: { id: string }) => r.id);
  if (slotIds.length === 0) {
    return { deletedAppointments: 0, deletedSlots: 0 };
  }

  let deletedAppointments = 0;
  for (const part of chunk(slotIds, 80)) {
    const { data: delApt, error: eA } = await supabase
      .from("appointments")
      .delete()
      .in("slot_id", part)
      .select("id");
    if (eA) throw eA;
    deletedAppointments += delApt?.length ?? 0;
  }

  let deletedSlots = 0;
  for (const part of chunk(slotIds, 80)) {
    const { data: delSl, error: eS } = await supabase
      .from("slots")
      .delete()
      .in("id", part)
      .select("id");
    if (eS) throw eS;
    deletedSlots += delSl?.length ?? 0;
  }

  return { deletedAppointments, deletedSlots };
}

export async function createPendingAppointment(
  supabase: SupabaseClient,
  input: {
    slot_id: string;
    client_id: string;
    notes?: string | null;
    idempotency_key: string;
  }
): Promise<AppointmentRow> {
  const { data, error } = await supabase
    .from("appointments")
    .insert({
      slot_id: input.slot_id,
      client_id: input.client_id,
      status: "pending_payment",
      notes: input.notes ?? null,
      idempotency_key: input.idempotency_key,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as AppointmentRow;
}

export async function setYookassaPaymentInfo(
  supabase: SupabaseClient,
  appointmentId: string,
  info: { paymentId: string; confirmationUrl: string }
): Promise<void> {
  const { error } = await supabase
    .from("appointments")
    .update({
      yookassa_payment_id: info.paymentId,
      yookassa_confirmation_url: info.confirmationUrl,
    })
    .eq("id", appointmentId);
  if (error) throw error;
}

export async function getAppointmentById(
  supabase: SupabaseClient,
  id: string
): Promise<AppointmentWithRelations | null> {
  const { data, error } = await supabase
    .from("appointments")
    .select("*, slots(*), clients(*)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as AppointmentWithRelations | null;
}

export async function getAppointmentByPaymentId(
  supabase: SupabaseClient,
  paymentId: string
): Promise<AppointmentWithRelations | null> {
  const { data, error } = await supabase
    .from("appointments")
    .select("*, slots(*), clients(*)")
    .eq("yookassa_payment_id", paymentId)
    .maybeSingle();
  if (error) throw error;
  return data as AppointmentWithRelations | null;
}

/** Подтверждает только если было pending_payment; changed=true → только что подтвердили (можно слать уведомления). */
export async function tryConfirmAppointment(
  supabase: SupabaseClient,
  appointmentId: string
): Promise<{
  apt: AppointmentWithRelations | null;
  changed: boolean;
}> {
  const { data: row, error } = await supabase
    .from("appointments")
    .update({ status: "confirmed" })
    .eq("id", appointmentId)
    .eq("status", "pending_payment")
    .select("id, slot_id")
    .maybeSingle();

  if (error) throw error;

  if (!row) {
    const apt = await getAppointmentById(supabase, appointmentId);
    return { apt, changed: false };
  }

  const { error: u2 } = await supabase
    .from("slots")
    .update({ is_booked: true })
    .eq("id", row.slot_id);

  if (u2) throw u2;

  const apt = await getAppointmentById(supabase, appointmentId);
  return { apt, changed: true };
}

export async function cancelAppointmentByAdmin(
  supabase: SupabaseClient,
  appointmentId: string
): Promise<AppointmentWithRelations | null> {
  const apt = await getAppointmentById(supabase, appointmentId);
  if (!apt) return null;
  if (apt.status !== "confirmed" && apt.status !== "pending_payment") {
    return apt;
  }

  const { error: u1 } = await supabase
    .from("appointments")
    .update({ status: "cancelled" })
    .eq("id", appointmentId);

  if (u1) throw u1;

  if (apt.status === "confirmed") {
    const { error: u2 } = await supabase
      .from("slots")
      .update({ is_booked: false })
      .eq("id", apt.slot_id);
    if (u2) throw u2;
  }

  return getAppointmentById(supabase, appointmentId);
}

export async function moveAppointmentToSlot(
  supabase: SupabaseClient,
  appointmentId: string,
  newSlotId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const apt = await getAppointmentById(supabase, appointmentId);
  if (!apt || apt.status !== "confirmed") {
    return { ok: false, reason: "Запись не найдена или не подтверждена" };
  }

  const { data: newSlot } = await supabase
    .from("slots")
    .select("id, is_booked, is_published")
    .eq("id", newSlotId)
    .maybeSingle();

  if (!newSlot?.is_published) {
    return { ok: false, reason: "Новый слот не найден или снят с публикации" };
  }

  const { data: blocking } = await supabase
    .from("appointments")
    .select("id")
    .eq("slot_id", newSlotId)
    .in("status", ["pending_payment", "confirmed"])
    .maybeSingle();

  if (blocking && blocking.id !== appointmentId) {
    return { ok: false, reason: "Новый слот уже занят" };
  }

  const oldSlotId = apt.slot_id;

  const { error: e1 } = await supabase
    .from("slots")
    .update({ is_booked: false })
    .eq("id", oldSlotId);
  if (e1) throw e1;

  const { error: e2 } = await supabase
    .from("appointments")
    .update({ slot_id: newSlotId })
    .eq("id", appointmentId);
  if (e2) throw e2;

  const { error: e3 } = await supabase
    .from("slots")
    .update({ is_booked: true })
    .eq("id", newSlotId);
  if (e3) throw e3;

  return { ok: true };
}

export async function listConfirmedAppointments(
  supabase: SupabaseClient,
  fromIso: string,
  toIso: string
): Promise<AppointmentWithRelations[]> {
  const { data, error } = await supabase
    .from("appointments")
    .select("*, slots(*), clients(*)")
    .eq("status", "confirmed")
    .limit(200);

  if (error) throw error;

  const rows = (data ?? []) as AppointmentWithRelations[];
  return rows
    .filter((r) => r.slots)
    .filter((r) => {
      const t = r.slots.starts_at;
      return t >= fromIso && t <= toIso;
    })
    .sort(
      (a, b) =>
        new Date(a.slots.starts_at).getTime() -
        new Date(b.slots.starts_at).getTime()
    );
}

/** Записи на приём в окне по времени слота: ожидает оплаты, подтверждена, отменена, завершена. */
export async function listAppointmentsInSlotRange(
  supabase: SupabaseClient,
  fromIso: string,
  toIso: string
): Promise<AppointmentWithRelations[]> {
  const { data, error } = await supabase
    .from("appointments")
    .select("*, slots(*), clients(*)")
    .in("status", [
      "pending_payment",
      "confirmed",
      "cancelled",
      "completed",
    ])
    .limit(500);

  if (error) throw error;

  const rows = (data ?? []) as AppointmentWithRelations[];
  return rows
    .filter((r) => r.slots)
    .filter((r) => {
      const t = r.slots.starts_at;
      return t >= fromIso && t <= toIso;
    })
    .sort(
      (a, b) =>
        new Date(a.slots.starts_at).getTime() -
        new Date(b.slots.starts_at).getTime()
    );
}

export async function getActiveAppointmentForClient(
  supabase: SupabaseClient,
  clientId: string
): Promise<AppointmentWithRelations | null> {
  const { data, error } = await supabase
    .from("appointments")
    .select("*, slots(*), clients(*)")
    .eq("client_id", clientId)
    .in("status", ["pending_payment", "confirmed"])
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  const row = data?.[0];
  return (row as AppointmentWithRelations) ?? null;
}

export async function expireStalePendingAppointments(
  supabase: SupabaseClient,
  olderThanMinutes: number
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const { data: stale, error: q } = await supabase
    .from("appointments")
    .select("id")
    .eq("status", "pending_payment")
    .lt("created_at", cutoff);

  if (q) throw q;
  const ids = (stale ?? []).map((r: { id: string }) => r.id);
  if (ids.length === 0) return 0;

  const { error: u } = await supabase
    .from("appointments")
    .update({ status: "cancelled" })
    .in("id", ids)
    .eq("status", "pending_payment");

  if (u) throw u;
  return ids.length;
}

export async function hasPaymentEvent(
  supabase: SupabaseClient,
  yookassaEventId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("payment_events")
    .select("id")
    .eq("yookassa_event_id", yookassaEventId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function insertPaymentEvent(
  supabase: SupabaseClient,
  yookassaEventId: string,
  appointmentId: string | null,
  payload: unknown
): Promise<void> {
  const { error } = await supabase.from("payment_events").insert({
    yookassa_event_id: yookassaEventId,
    appointment_id: appointmentId,
    payload: payload as object,
  });

  if (error && error.code !== "23505") throw error;
}

export async function markReminderSent(
  supabase: SupabaseClient,
  appointmentId: string,
  kind: "2h" | "1h"
): Promise<void> {
  const field = kind === "2h" ? "reminder_2h_sent_at" : "reminder_1h_sent_at";
  const { error } = await supabase
    .from("appointments")
    .update({ [field]: new Date().toISOString() })
    .eq("id", appointmentId);
  if (error) throw error;
}

export async function fetchAppointmentsForReminder(
  supabase: SupabaseClient,
  windowMin: number,
  windowMax: number,
  kind: "2h" | "1h"
): Promise<AppointmentWithRelations[]> {
  const now = Date.now();
  const sentField = kind === "2h" ? "reminder_2h_sent_at" : "reminder_1h_sent_at";

  let q = supabase
    .from("appointments")
    .select("*, slots(*), clients(*)")
    .eq("status", "confirmed")
    .is(sentField, null);

  if (kind === "1h") {
    q = q.eq("reminder_skip_one_hour", false);
  }

  const { data, error } = await q;

  if (error) throw error;
  const rows = (data ?? []) as AppointmentWithRelations[];

  return rows.filter((r) => {
    const start = new Date(r.slots.starts_at).getTime();
    const t = start - now;
    const minMs = windowMin * 60_000;
    const maxMs = windowMax * 60_000;
    return t >= minMs && t <= maxMs;
  });
}

export async function setReminderSkipOneHour(
  supabase: SupabaseClient,
  appointmentId: string
): Promise<void> {
  const { error } = await supabase
    .from("appointments")
    .update({ reminder_skip_one_hour: true })
    .eq("id", appointmentId);
  if (error) throw error;
}
