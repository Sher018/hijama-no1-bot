import { loadEnv } from "./config/env.js";
import { createSupabase } from "./db/supabase.js";
import { buildBot } from "./bot/setup.js";
import { createHttpServer, syncTelegramWebhook } from "./api/httpServer.js";
import { startSchedulers } from "./scheduler/reminders.js";

const env = loadEnv();
const supabase = createSupabase(env);
const bot = buildBot(env, supabase);

const usePolling =
  Boolean(env.TELEGRAM_USE_POLLING) || !env.PUBLIC_BASE_URL;

const app = createHttpServer(env, supabase, bot, {
  useTelegramWebhook: !usePolling,
});

const stopSchedulers = startSchedulers(env, supabase, bot);

const server = app.listen(env.PORT, async () => {
  console.log(`HTTP listening on :${env.PORT}`);
  try {
    await syncTelegramWebhook(bot, env, !usePolling);
    if (usePolling) {
      await bot.launch();
      console.log("Telegram bot: long polling");
    }
  } catch (e) {
    console.error("Bot startup error", e);
    process.exit(1);
  }
});

async function shutdown(signal: string) {
  console.log(`${signal}, shutting down…`);
  stopSchedulers();
  try {
    await bot.stop(signal);
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
