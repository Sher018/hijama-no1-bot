import path from "node:path";
import express from "express";
import type { Telegraf } from "telegraf";
import type { Env } from "../config/env.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppVersion } from "../appMeta.js";
import { projectRoot } from "../paths.js";
import { createYookassaWebhookHandler } from "../services/paymentWebhook.js";

const TELEGRAM_WEBHOOK_PATH = "/webhooks/telegram";

export function createHttpServer(
  env: Env,
  supabase: SupabaseClient,
  bot: Telegraf,
  options: { useTelegramWebhook: boolean }
): express.Express {
  const app = express();
  /** Картинки услуг и приветствия: https://&lt;PUBLIC_BASE_URL&gt;/assets/bot/... */
  app.use(
    "/assets",
    express.static(path.join(projectRoot(), "assets"), {
      maxAge: "7d",
      immutable: true,
    })
  );
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, version: getAppVersion() });
  });

  app.post(
    "/webhooks/yookassa",
    createYookassaWebhookHandler(env, supabase, bot)
  );

  if (options.useTelegramWebhook && env.PUBLIC_BASE_URL) {
    app.post(TELEGRAM_WEBHOOK_PATH, (req, res) => {
      void bot.handleUpdate(req.body, res);
    });
  }

  return app;
}

export type TelegramDeliveryMode = "webhook" | "polling";

/** Регистрирует webhook; при ошибке (неверный DNS, Telegram не видит хост) — polling без падения процесса. */
export async function syncTelegramWebhook(
  bot: Telegraf,
  env: Env,
  useWebhook: boolean
): Promise<{ mode: TelegramDeliveryMode; webhookUrl?: string }> {
  const base = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (useWebhook && base) {
    const url = `${base}${TELEGRAM_WEBHOOK_PATH}`;
    try {
      await bot.telegram.setWebhook(url);
      console.log(`Telegram webhook: ${url}`);
      return { mode: "webhook", webhookUrl: url };
    } catch (e) {
      console.error(
        "setWebhook не удался (проверьте PUBLIC_BASE_URL в браузере и раздел «Домены» в Amvera). Переход на long polling.",
        e
      );
      await bot.telegram.deleteWebhook({ drop_pending_updates: false });
      return { mode: "polling" };
    }
  }
  await bot.telegram.deleteWebhook({ drop_pending_updates: false });
  console.log("Telegram: long polling");
  return { mode: "polling" };
}
