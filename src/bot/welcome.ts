import { Markup } from "telegraf";
import type { Context } from "telegraf";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getWelcomeText } from "../services/settingsRepo.js";
import {
  WELCOME_IMAGE_FILE,
  assetPath,
  fileExists,
  publicAssetUrl,
} from "./content/servicesCatalog.js";

/** 2GIS — точка на карте; текст адреса ведёт по этой ссылке. */
const ADDRESS_2GIS_URL =
  "https://2gis.ru/irkutsk/inside/1548748027092936/firm/70000001059811567?m=104.290251%2C52.279281%2F16";

const CHANNEL_TG_URL = "https://t.me/hidjama_akmal";

/** Лимит подписи к фото в Telegram (UTF-16 code units). */
const PHOTO_CAPTION_MAX = 1024;

/** Подпись к фото, если полный текст не помещается — основной текст отдельным сообщением. */
const WELCOME_PHOTO_SHORT_CAPTION =
  "«Хиджама №1» · Иркутск · подробности — в сообщении ниже 👇";

/**
 * HTML по умолчанию (parse_mode HTML). В Supabase ключ `welcome_text` может переопределить.
 */
export const DEFAULT_WELCOME_HTML = [
  "🤲 Ассаляму алейкум, уважаемый гость!",
  "",
  "Добро пожаловать в <b>«Хиджама №1»</b> — специализированную клинику традиционной исламской медицины в Иркутске.",
  "",
  "Здесь мастер Акмал помогает людям через хиджаму и современные восстановительные методики:",
  "",
  "🩸 <b>Хиджама</b> — классическое кровопускание по сунне",
  "💆‍♂️ Лечебный массаж",
  "🔨 Перкуссионная терапия",
  "🪡 Метод сухой иглы",
  "🤲 Мягкие мануальные техники",
  "🫙 Вакуум-градиентная терапия",
  "🧲 Магнит высокой интенсивности",
  "⚡ Ударно-волновая терапия (УВТ)",
  "",
  "Каждая процедура подбирается индивидуально с целью очищения организма, снятия боли, улучшения кровообращения и общего восстановления.",
  "",
  `📍 <b>Адрес:</b> <a href="${ADDRESS_2GIS_URL}">Киевская улица, 24, офис 306, 3 этаж</a>`,
  `📲 Наш Telegram-канал: <a href="${CHANNEL_TG_URL}">t.me/hidjama_akmal</a>`,
  "",
  "⎯⎯⎯",
  "",
  "<b>Как я могу помочь вам сегодня?</b>",
  "",
  "Нажмите кнопку ниже, чтобы:",
  "• Посмотреть свободные слоты",
  "• Записаться на хиджаму или другую процедуру",
  "• Узнать цены и детали",
  "",
  "Мы ценим ваше время и здоровье. Запись ведётся с предоплатой 500 ₽ для подтверждения.",
  "",
  "Добро пожаловать! 🌿",
].join("\n");

/** @deprecated используйте DEFAULT_WELCOME_HTML; оставлено для совместимости импортов */
export const DEFAULT_WELCOME_CAPTION = DEFAULT_WELCOME_HTML;

export function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Услуги", "menu:services"),
      Markup.button.callback("Записаться", "book"),
    ],
  ]);
}

function botTgUrl(botUsername: string): string {
  const u = botUsername.replace(/^@/, "").trim();
  return `https://t.me/${u}`;
}

/**
 * Текст поста в канал: призыв записаться через бота (HTML).
 */
export function channelCallToBookHtml(botUsername: string): string {
  const botUrl = botTgUrl(botUsername);
  const botLabel = `@${botUsername.replace(/^@/, "")}`;
  return [
    "🤲 Ассаляму алейкум, дорогие друзья и братья!",
    "",
    "Как ваши дела? ❤️",
    "",
    "В «Хиджама №1» мастер Акмал с радостью ждёт вас на этой и следующей неделе. Осталось несколько приятных свободных окошек.",
    "",
    "Мы помогаем через:",
    "🩸 Хиджаму по сунне",
    "💆‍♂️ Лечебный массаж",
    "🔨 Перкуссионную терапию",
    "🪡 Сухую иглу",
    "🫙 Вакуум-градиентную терапию",
    "⚡ Ударно-волновую терапию и другие процедуры",
    "",
    "Каждому гостю подбираем всё индивидуально, с заботой и вниманием, чтобы вы уходили с лёгкостью в теле и спокойствием в душе.",
    "",
    `📍 <b>Адрес:</b> <a href="${ADDRESS_2GIS_URL}">Киевская улица, 24, офис 306 (3 этаж)</a>`,
    "",
    `Записаться очень просто — напишите нашему боту <a href="${botUrl}">${botLabel}</a>`,
    "Предоплата 500 ₽ идёт в счёт процедуры.",
    "",
    "Будем рады видеть вас!",
    "Запишитесь, если чувствуете, что пора позаботиться о себе 🌿",
    "",
    "С теплом и уважением,",
    "команда «Хиджама №1»",
  ].join("\n");
}

/** message_id приветствия — чтобы не удалять его при навигации (сообщение с кнопками). */
export async function sendMainWelcome(
  ctx: Context,
  supabase: SupabaseClient,
  publicBaseUrl?: string
): Promise<number | undefined> {
  const html = await getWelcomeText(supabase, DEFAULT_WELCOME_HTML);
  const extraHtml = {
    ...mainMenuKeyboard(),
    parse_mode: "HTML" as const,
  };

  const img = assetPath(WELCOME_IMAGE_FILE);
  const remoteUrl = publicAssetUrl(publicBaseUrl, WELCOME_IMAGE_FILE);

  const sendPhoto = async (
    photo: { source: string } | { url: string },
    caption: string,
    withKeyboard: boolean
  ) => {
    const ex = withKeyboard
      ? { caption, ...extraHtml }
      : { caption, parse_mode: "HTML" as const };
    return ctx.replyWithPhoto(photo, ex);
  };

  if (fileExists(img)) {
    if (html.length <= PHOTO_CAPTION_MAX) {
      const m = await sendPhoto({ source: img }, html, true);
      return m.message_id;
    }
    await sendPhoto({ source: img }, WELCOME_PHOTO_SHORT_CAPTION, false);
    const m = await ctx.reply(html, extraHtml);
    return m.message_id;
  }

  if (remoteUrl) {
    try {
      if (html.length <= PHOTO_CAPTION_MAX) {
        const m = await sendPhoto({ url: remoteUrl }, html, true);
        return m.message_id;
      }
      await sendPhoto({ url: remoteUrl }, WELCOME_PHOTO_SHORT_CAPTION, false);
      const m = await ctx.reply(html, extraHtml);
      return m.message_id;
    } catch (e) {
      console.warn(
        "Приветствие: нет файла локально и не удалось загрузить по URL",
        remoteUrl,
        e
      );
      const m = await ctx.reply(html, extraHtml);
      return m.message_id;
    }
  }

  const m = await ctx.reply(html, extraHtml);
  return m.message_id;
}
