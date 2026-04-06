import type { Telegraf } from "telegraf";
import type { Env } from "../config/env.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppointmentWithRelations } from "../db/types.js";
import {
  getAppointmentById,
  tryConfirmAppointment,
} from "./appointmentsRepo.js";
import { getYookassaPayment } from "./yookassaClient.js";
import { formatSlotRu } from "../util/time.js";

export async function notifyAfterSuccessfulPayment(
  env: Env,
  bot: Telegraf,
  after: AppointmentWithRelations
): Promise<void> {
  const when = formatSlotRu(after.slots.starts_at);
  const clientTg = after.clients.telegram_user_id;
  const name = after.clients.full_name ?? "Клиент";
  const phone = after.clients.phone ?? "—";

  try {
    await bot.telegram.sendMessage(
      clientTg,
      [
        "Оплата прошла успешно. Запись подтверждена.",
        "",
        `Дата и время: ${when}`,
        `Предоплата: ${after.prepayment_rub} ₽`,
        `Стоимость сеанса на месте: ${after.session_price_min_rub}–${after.session_price_max_rub} ₽`,
        "",
        "До встречи в клинике «Хиджама №1».",
      ].join("\n")
    );
  } catch (e) {
    console.error("notify client after payment", e);
  }

  try {
    await bot.telegram.sendMessage(
      env.ADMIN_TELEGRAM_ID,
      [
        "Новая запись (оплачена).",
        "",
        `Время: ${when}`,
        `Клиент: ${name}`,
        `Телефон: ${phone}`,
        `Telegram ID: ${clientTg}`,
        `@${after.clients.telegram_username ?? "—"}`,
        `Предоплата: ${after.prepayment_rub} ₽`,
        `Запись ID: ${after.id}`,
      ].join("\n")
    );
  } catch (e) {
    console.error("notify admin after payment", e);
  }
}

/**
 * Если вебхук ЮKassa не дошёл, опрос API подтверждает оплату и запись.
 * Возвращает true, если запись переведена в confirmed и отправлены уведомления.
 */
export async function syncPendingPaymentFromYookassaApi(
  env: Env,
  supabase: SupabaseClient,
  bot: Telegraf,
  appointmentId: string
): Promise<boolean> {
  const apt = await getAppointmentById(supabase, appointmentId);
  if (!apt || apt.status !== "pending_payment" || !apt.yookassa_payment_id) {
    return false;
  }
  const payment = await getYookassaPayment(env, apt.yookassa_payment_id);
  if (!payment || payment.status !== "succeeded") {
    return false;
  }
  const { apt: after, changed } = await tryConfirmAppointment(
    supabase,
    appointmentId
  );
  if (!changed || !after || after.status !== "confirmed") {
    return false;
  }
  await notifyAfterSuccessfulPayment(env, bot, after);
  return true;
}
