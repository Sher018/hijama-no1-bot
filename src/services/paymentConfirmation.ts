import type { Telegraf } from "telegraf";
import { adminTelegramIds, type Env } from "../config/env.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppointmentWithRelations } from "../db/types.js";
import {
  getAppointmentById,
  tryConfirmAppointment,
} from "./appointmentsRepo.js";
import { formatSelectedProcedureLine } from "./procedureLine.js";
import { getYookassaPayment } from "./yookassaClient.js";
import { formatSlotRu } from "../util/time.js";

export async function notifyAfterSuccessfulPayment(
  env: Env,
  supabase: SupabaseClient,
  bot: Telegraf,
  after: AppointmentWithRelations
): Promise<void> {
  const when = formatSlotRu(after.slots.starts_at);
  const clientTg = after.clients.telegram_user_id;
  const name = after.clients.full_name ?? "Клиент";
  const phone = after.clients.phone ?? "—";
  const procLine = await formatSelectedProcedureLine(supabase, after.notes);

  try {
    await bot.telegram.sendMessage(
      clientTg,
      [
        "✅ Оплата прошла успешно. Запись подтверждена.",
        "",
        `📅 ${when}`,
        `💳 Предоплата: ${after.prepayment_rub} ₽`,
        ...(procLine ? [procLine] : []),
        "",
        "До встречи в клинике «Хиджама №1»! 🙏",
      ].join("\n")
    );
  } catch (e) {
    console.error("notify client after payment", e);
  }

  const adminText = [
    "💚 Новая запись (оплачена).",
    "",
    `📅 ${when}`,
    `👤 ${name}`,
    `📞 ${phone}`,
    after.clients.telegram_username
      ? `@${after.clients.telegram_username}`
      : "",
    `💳 Предоплата: ${after.prepayment_rub} ₽`,
  ]
    .filter(Boolean)
    .join("\n");
  for (const adminId of adminTelegramIds(env)) {
    try {
      await bot.telegram.sendMessage(adminId, adminText);
    } catch (e) {
      console.error("notify admin after payment", e);
    }
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
  await notifyAfterSuccessfulPayment(env, supabase, bot, after);
  return true;
}
