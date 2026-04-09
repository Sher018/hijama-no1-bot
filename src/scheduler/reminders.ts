import { Markup } from "telegraf";
import type { Telegraf } from "telegraf";
import { adminTelegramIds, type Env } from "../config/env.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  expireStalePendingAppointments,
  fetchAppointmentsForReminder,
  markReminderSent,
  purgeOldSlotsAndAppointments,
} from "../services/appointmentsRepo.js";
import { ensureStandardDailySlots } from "../services/autoSlots.js";
import { formatSlotRu } from "../util/time.js";

const TICK_MS = 120_000;
const PENDING_TTL_MIN = 30;

export function startSchedulers(
  env: Env,
  supabase: SupabaseClient,
  bot: Telegraf
): () => void {
  const tick = async () => {
    try {
      const { deletedAppointments, deletedSlots } =
        await purgeOldSlotsAndAppointments(supabase);
      if (deletedAppointments > 0 || deletedSlots > 0) {
        console.log(
          `Очистка прошлых периодов: записей ${deletedAppointments}, слотов ${deletedSlots}`
        );
      }
    } catch (e) {
      console.error("purgeOldSlotsAndAppointments", e);
    }

    try {
      await ensureStandardDailySlots(supabase, env);
    } catch (e) {
      console.error("ensureStandardDailySlots", e);
    }

    try {
      const n = await expireStalePendingAppointments(supabase, PENDING_TTL_MIN);
      if (n > 0) console.log(`Истекло ожидание оплаты, отменено записей: ${n}`);
    } catch (e) {
      console.error("expireStalePendingAppointments", e);
    }

    for (const kind of ["2h", "1h"] as const) {
      const windowMin = kind === "2h" ? 115 : 55;
      const windowMax = kind === "2h" ? 125 : 65;
      try {
        const list = await fetchAppointmentsForReminder(
          supabase,
          windowMin,
          windowMax,
          kind
        );
        for (const apt of list) {
          const when = formatSlotRu(apt.slots.starts_at);
          const clientId = apt.clients.telegram_user_id;

          try {
            await markReminderSent(supabase, apt.id, kind);
          } catch (e) {
            console.error("markReminderSent", e);
            continue;
          }

          try {
            if (kind === "2h") {
              await bot.telegram.sendMessage(
                clientId,
                [
                  "⏰ Через 2 часа сеанс в «Хиджама №1».",
                  "",
                  `📅 ${when}`,
                  "",
                  "Если вы точно придёте — нажмите кнопку ниже: напоминание за час не отправим.",
                ].join("\n"),
                Markup.inlineKeyboard([
                  [
                    Markup.button.callback(
                      "✅ Приду, за час не напоминать",
                      `rem:skip1h:${apt.id}`
                    ),
                  ],
                ])
              );
            } else {
              await bot.telegram.sendMessage(
                clientId,
                [
                  "🔔 Через 1 час сеанс в «Хиджама №1».",
                  "",
                  `📅 ${when}`,
                  "",
                  "До встречи!",
                ].join("\n")
              );
            }
          } catch (e) {
            console.error(`reminder ${kind} to client`, e);
          }

          const name = apt.clients.full_name?.trim() || "Клиент";
          const phone = apt.clients.phone?.trim() || "—";
          const adminMsg =
            kind === "2h"
              ? [
                  "⏰ Через 2 часа сеанс.",
                  "",
                  `📅 ${when}`,
                  "",
                  `👤 ${name}`,
                  `📞 ${phone}`,
                ].join("\n")
              : [
                  "🔔 Через 1 час сеанс.",
                  "",
                  `📅 ${when}`,
                  "",
                  `👤 ${name}`,
                  `📞 ${phone}`,
                ].join("\n");
          for (const adminId of adminTelegramIds(env)) {
            try {
              await bot.telegram.sendMessage(adminId, adminMsg);
            } catch (e) {
              console.error(`reminder ${kind} to admin`, e);
            }
          }
        }
      } catch (e) {
        console.error("fetchAppointmentsForReminder", e);
      }
    }
  };

  void tick();
  const id = setInterval(() => void tick(), TICK_MS);
  return () => clearInterval(id);
}
