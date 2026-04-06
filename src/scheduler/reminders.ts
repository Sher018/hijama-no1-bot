import type { Telegraf } from "telegraf";
import type { Env } from "../config/env.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  expireStalePendingAppointments,
  fetchAppointmentsForReminder,
  markReminderSent,
  purgeOldSlotsAndAppointments,
} from "../services/appointmentsRepo.js";
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
            await bot.telegram.sendMessage(
              clientId,
              kind === "2h"
                ? `Напоминание: через 2 часа ваш сеанс в «Хиджама №1».\n${when}`
                : `Напоминание: через 1 час ваш сеанс в «Хиджама №1».\n${when}`
            );
            await markReminderSent(supabase, apt.id, kind);
          } catch (e) {
            console.error(`reminder ${kind} to client`, e);
          }

          try {
            await bot.telegram.sendMessage(
              env.ADMIN_TELEGRAM_ID,
              kind === "2h"
                ? `Через 2 часа сеанс.\n${when}\n${apt.clients.full_name ?? "Клиент"} / ${apt.clients.phone ?? "—"}`
                : `Через 1 час сеанс.\n${when}\n${apt.clients.full_name ?? "Клиент"} / ${apt.clients.phone ?? "—"}`
            );
          } catch (e) {
            console.error(`reminder ${kind} to admin`, e);
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
