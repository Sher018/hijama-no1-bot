import express from "express";
import type { Telegraf } from "telegraf";
import type { Env } from "../config/env.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createYookassaWebhookHandler } from "../services/paymentWebhook.js";

const TELEGRAM_WEBHOOK_PATH = "/webhooks/telegram";

export function createHttpServer(
  env: Env,
  supabase: SupabaseClient,
  bot: Telegraf,
  options: { useTelegramWebhook: boolean }
): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
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

export async function syncTelegramWebhook(
  bot: Telegraf,
  env: Env,
  useWebhook: boolean
): Promise<void> {
  const base = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (useWebhook && base) {
    const url = `${base}${TELEGRAM_WEBHOOK_PATH}`;
    await bot.telegram.setWebhook(url);
    console.log(`Telegram webhook: ${url}`);
  } else {
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    console.log("Telegram: long polling");
  }
}
