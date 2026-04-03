import type { Request, Response } from "express";
import type { Telegraf } from "telegraf";
import type { Env } from "../config/env.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAppointmentById,
  getAppointmentByPaymentId,
  hasPaymentEvent,
  insertPaymentEvent,
  tryConfirmAppointment,
} from "./appointmentsRepo.js";
import { formatSlotRu } from "../util/time.js";

function checkBasicAuth(req: Request, env: Env): boolean {
  const h = req.headers.authorization;
  if (!h?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(h.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return (
    user === env.YOOKASSA_WEBHOOK_USER && pass === env.YOOKASSA_WEBHOOK_PASSWORD
  );
}

interface YooNotification {
  type?: string;
  event?: string;
  object?: {
    id?: string;
    status?: string;
    metadata?: Record<string, string>;
  };
}

export function createYookassaWebhookHandler(
  env: Env,
  supabase: SupabaseClient,
  bot: Telegraf
) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!checkBasicAuth(req, env)) {
      res.status(401).end();
      return;
    }

    const body = req.body as YooNotification;
    const event = body.event;
    const payment = body.object;
    const paymentId = payment?.id;

    if (!paymentId || !event) {
      res.status(200).end();
      return;
    }

    const yookassaEventId = `${paymentId}:${event}`;

    try {
      if (await hasPaymentEvent(supabase, yookassaEventId)) {
        res.status(200).end();
        return;
      }

      if (event !== "payment.succeeded") {
        await insertPaymentEvent(supabase, yookassaEventId, null, body);
        res.status(200).end();
        return;
      }

      let appointmentId = payment?.metadata?.appointment_id;
      let apt = appointmentId
        ? await getAppointmentById(supabase, appointmentId)
        : null;

      if (!apt) {
        apt = await getAppointmentByPaymentId(supabase, paymentId);
        appointmentId = apt?.id;
      }

      if (!apt || !appointmentId) {
        await insertPaymentEvent(supabase, yookassaEventId, null, body);
        res.status(200).end();
        return;
      }

      const { apt: after, changed } = await tryConfirmAppointment(
        supabase,
        appointmentId
      );

      if (changed && after && after.status === "confirmed") {
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

      await insertPaymentEvent(supabase, yookassaEventId, appointmentId, body);
    } catch (e) {
      console.error("yookassa webhook", e);
      res.status(500).end();
      return;
    }

    res.status(200).end();
  };
}
