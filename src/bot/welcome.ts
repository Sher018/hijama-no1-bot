import { Markup } from "telegraf";
import type { Context } from "telegraf";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getWelcomeText } from "../services/settingsRepo.js";
import {
  WELCOME_IMAGE_FILE,
  assetPath,
  fileExists,
} from "./content/servicesCatalog.js";

export const DEFAULT_WELCOME_CAPTION = [
  "Ассаляму алейкум ва рахматуЛЛохи ва баракяту!",
  "",
  "Процедура хиджама — одна из проверенных столетиями медицинских практик; название с арабского переводится как «высасывать». Она сочетает кровопускание с использованием вакуумных банок для усиления эффекта.",
  "",
  "Вы в боте клиники «Хиджама №1» (Иркутск). Здесь можно:",
  "• узнать об услугах и ценах;",
  "• записаться на приём и внести предоплату 500 ₽;",
  "• получить напоминания о визите.",
  "",
  "Полная стоимость сеанса оплачивается на месте (ориентир 3500–6000 ₽ в зависимости от программы).",
  "",
  "Выберите «Услуги» или «Записаться».",
].join("\n");

export function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Услуги", "menu:services"),
      Markup.button.callback("Записаться", "book"),
    ],
  ]);
}

export async function sendMainWelcome(
  ctx: Context,
  supabase: SupabaseClient
): Promise<void> {
  const caption = await getWelcomeText(supabase, DEFAULT_WELCOME_CAPTION);
  const img = assetPath(WELCOME_IMAGE_FILE);
  const extra = {
    ...mainMenuKeyboard(),
  };

  if (fileExists(img)) {
    await ctx.replyWithPhoto({ source: img }, { caption, ...extra });
  } else {
    await ctx.reply(caption, extra);
  }
}
