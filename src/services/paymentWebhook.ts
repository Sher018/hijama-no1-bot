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
import { notifyAfterSuccessfulPayment } from "./paymentConfirmation.js";

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

interface YooPaymentObject {
  id?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

interface YooNotification {
  type?: string;
  event?: string;
  object?: YooPaymentObject;
}

function metadataAppointmentId(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const m = meta as Record<string, unknown>;
  const v = m.appointment_id;
  if (typeof v === "string") return v;
  if (v != null) return String(v);
  return undefined;
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

      let appointmentId = metadataAppointmentId(payment?.metadata);
      let apt = appointmentId
        ? await getAppointmentById(supabase, appointmentId)
        : null;

      if (!apt) {
        apt = await getAppointmentByPaymentId(supabase, paymentId);
        appointmentId = apt?.id;
      }

      if (!apt || !appointmentId) {
        console.warn(
          `yookassa webhook: нет записи для платежа ${paymentId}, metadata=`,
          payment?.metadata
        );
        await insertPaymentEvent(supabase, yookassaEventId, null, body);
        res.status(200).end();
        return;
      }

      const { apt: after, changed } = await tryConfirmAppointment(
        supabase,
        appointmentId
      );

      if (changed && after && after.status === "confirmed") {
        await notifyAfterSuccessfulPayment(env, supabase, bot, after);
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
