import { Telegraf, session, Markup } from "telegraf";
import type { Context } from "telegraf";
import { randomUUID } from "node:crypto";
import type { Env } from "../config/env.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AppointmentStatus,
  AppointmentWithRelations,
  SlotRow,
} from "../db/types.js";
import { upsertClient, getClientByTelegramId } from "../services/clientsRepo.js";
import {
  createPendingAppointment,
  setYookassaPaymentInfo,
  getActiveAppointmentForClient,
  getAppointmentById,
  setReminderSkipOneHour,
  cancelAppointmentByAdmin,
  moveAppointmentToSlot,
  listAppointmentsInSlotRange,
} from "../services/appointmentsRepo.js";
import {
  listAvailableSlots,
  getSlot,
  insertSlot,
  countSlotsStartingInRange,
  listSlotsAdmin,
  deleteSlotIfFree,
  setSlotPublished,
} from "../services/slotsRepo.js";
import {
  getServicePrices,
  setServicePrice,
} from "../services/settingsRepo.js";
import { createYookassaPayment } from "../services/yookassaClient.js";
import { syncPendingPaymentFromYookassaApi } from "../services/paymentConfirmation.js";
import { formatSelectedProcedureLine } from "../services/procedureLine.js";
import {
  formatShortRu,
  formatSlotRu,
  formatIrkutskDateOnly,
  formatIrkutskTimeHm,
  formatWeekdayDdMmYyyyFromYmd,
  nextIrkutskDayRangeYmd,
  irkutskDayUtcRange,
  isoYmdToDdMmYyyy,
  ddMmYyyyToIsoYmd,
  parseIrkutskStartEnd,
} from "../util/time.js";
import { escapeHtml } from "../util/escapeHtml.js";
import { isWithinWorkingHours } from "../util/workingHours.js";
import {
  addClosureDay,
  listClosureDays,
  removeClosureDay,
} from "../services/closureDaysRepo.js";
import { sendMainWelcome } from "./welcome.js";
import {
  SERVICES,
  assetPath,
  fileExists,
  getServiceById,
  publicAssetUrl,
  telegramInlineButtonText,
} from "./content/servicesCatalog.js";

interface SessionData {
  step?: "name" | "phone" | "admin_closure" | "admin_price" | "admin_addslot";
  slotId?: string;
  tempName?: string;
  adminPriceServiceId?: string;
  /** услуга из раздела «Услуги» (для цены в сообщении об оплате) */
  selectedServiceId?: string;
  /** message_id приветствия — не удалять при навигации по кнопкам */
  welcomeMessageId?: number;
}

type BotContext = Context & { session?: SessionData };

/** Только inline-клавиатура, как у editMessageText (без deep-import из telegraf/typings). */
type InlineMessageExtra = NonNullable<
  Parameters<BotContext["editMessageText"]>[1]
>;

function isAdmin(ctx: BotContext, env: Env): boolean {
  return ctx.from?.id === env.ADMIN_TELEGRAM_ID;
}

/** Закреплённая reply-клавиатура админа (Telegram «закрепить» внизу чата). */
function adminPinnedReplyKb() {
  return Markup.keyboard([
    ["Выходные дни", "Цены услуг"],
    ["Слоты и записи", "Справка"],
  ])
    .resize()
    .persistent();
}

function adminBookingPaymentLine(status: AppointmentStatus): string {
  switch (status) {
    case "confirmed":
    case "completed":
      return "✅ Оплачено";
    case "pending_payment":
      return "⏳ Ожидает оплаты";
    case "cancelled":
      return "❌ Не оплачено";
    default:
      return String(status);
  }
}

function formatAdminBookingMessage(a: AppointmentWithRelations): string {
  const name = a.clients.full_name?.trim() || "—";
  const phone = a.clients.phone?.trim() || "—";
  return [
    formatSlotRu(a.slots.starts_at),
    `Имя: ${name}`,
    `Телефон: ${phone}`,
    `Статус: ${adminBookingPaymentLine(a.status)}`,
  ].join("\n");
}

/** Шаг 1 записи: всегда 7 календарных дней (Иркутск), по одной кнопке в строке. */
const SLOT_BOOK_CALENDAR_DAYS = 7;

function buildBookDateRows(slots: SlotRow[]) {
  const byDate = new Map<string, SlotRow[]>();
  for (const s of slots) {
    const d = formatIrkutskDateOnly(s.starts_at);
    const arr = byDate.get(d) ?? [];
    arr.push(s);
    byDate.set(d, arr);
  }
  const week = nextIrkutskDayRangeYmd(SLOT_BOOK_CALENDAR_DAYS);
  const rows = week.map((ymd) => {
    const list = byDate.get(ymd) ?? [];
    const has = list.length > 0;
    const base = formatWeekdayDdMmYyyyFromYmd(ymd);
    const label = has ? base : `${base} · нет мест`;
    return [
      Markup.button.callback(
        telegramInlineButtonText(label),
        has ? `bookday:${ymd}` : `bookunavail:${ymd}`
      ),
    ];
  });
  rows.push([Markup.button.callback("« Назад", "menu:main")]);
  return rows;
}

async function deleteMessageIfNotWelcome(
  ctx: BotContext,
  messageId: number | undefined
): Promise<void> {
  if (!ctx.chat?.id || messageId === undefined) return;
  if (messageId === ctx.session?.welcomeMessageId) return;
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
  } catch {
    /* ignore */
  }
}

async function answerAndEditOrReplyText(
  ctx: BotContext,
  text: string,
  extra?: InlineMessageExtra
): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  await ctx.answerCbQuery();
  if (msg && "photo" in msg) {
    await deleteMessageIfNotWelcome(ctx, msg.message_id);
    await ctx.reply(text, extra as Parameters<BotContext["reply"]>[1]);
  } else if (ctx.callbackQuery && msg && "text" in msg) {
    await ctx.editMessageText(text, extra);
  }
}

async function replyPendingPayment(
  ctx: BotContext,
  active: AppointmentWithRelations,
  env: Env,
  supabase: SupabaseClient,
  bot: Telegraf<BotContext>
): Promise<void> {
  await syncPendingPaymentFromYookassaApi(env, supabase, bot, active.id);
  const fresh = await getAppointmentById(supabase, active.id);
  const cur = fresh ?? active;
  const procLine = await formatSelectedProcedureLine(supabase, cur.notes);
  if (cur.status === "confirmed") {
    await ctx.reply(
      [
        "✅ Оплата получена, запись подтверждена.",
        "",
        `📅 ${formatSlotRu(cur.slots.starts_at)}`,
        `💳 Предоплата: ${cur.prepayment_rub} ₽`,
        ...(procLine ? ["", procLine] : []),
        "",
        "До встречи в клинике «Хиджама №1»! 🙏",
      ].join("\n")
    );
    return;
  }
  const lines = [
    "💳 У вас есть запись, ожидающая оплаты.",
    `📅 ${formatSlotRu(cur.slots.starts_at)}`,
    ...(procLine ? [procLine] : []),
    "",
    "После оплаты вы вернётесь в бот — придёт подтверждение.",
    "",
    "Если оплата прошла, а подтверждение не пришло — нажмите /start или отправьте любое сообщение боту.",
  ];
  const url = cur.yookassa_confirmation_url;
  if (url) {
    await ctx.reply(
      lines.join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.url(`Оплатить ${cur.prepayment_rub} ₽`, url)],
      ])
    );
    return;
  }
  await ctx.reply(
    [
      ...lines,
      "",
      "Ссылка на оплату недоступна (обновите проект и миграции БД или начните запись снова после истечения резерва ~30 мин).",
    ].join("\n")
  );
}

export function buildBot(env: Env, supabase: SupabaseClient): Telegraf<BotContext> {
  const bot = new Telegraf<BotContext>(env.BOT_TOKEN);

  const pendingSyncThrottle = new Map<number, number>();

  bot.use(
    session({
      defaultSession: (): SessionData => ({}),
    })
  );

  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.chat?.type !== "private") return next();
    const uid = ctx.from.id;
    const now = Date.now();
    if (now - (pendingSyncThrottle.get(uid) ?? 0) < 25_000) return next();
    pendingSyncThrottle.set(uid, now);
    const client = await getClientByTelegramId(supabase, ctx.from.id);
    if (!client) return next();
    const active = await getActiveAppointmentForClient(supabase, client.id);
    if (active?.status !== "pending_payment") return next();
    await syncPendingPaymentFromYookassaApi(env, supabase, bot, active.id);
    return next();
  });

  bot.start(async (ctx) => {
    if (!ctx.from) return;
    await upsertClient(supabase, {
      telegram_user_id: ctx.from.id,
      telegram_username: ctx.from.username ?? null,
    });

    const client = await getClientByTelegramId(supabase, ctx.from.id);
    if (client) {
      const active = await getActiveAppointmentForClient(supabase, client.id);
      if (active?.status === "pending_payment") {
        await replyPendingPayment(ctx, active, env, supabase, bot);
        return;
      }
      if (active?.status === "confirmed") {
        await ctx.reply(
          [
            "📋 У вас уже есть подтверждённая запись:",
            formatSlotRu(active.slots.starts_at),
            "",
            "Перенос и отмена — по согласованию с мастером (напишите в этот чат).",
          ].join("\n")
        );
        return;
      }
    }

    ctx.session ??= {};
    const welcomeId = await sendMainWelcome(ctx, supabase, env.PUBLIC_BASE_URL);
    if (welcomeId) ctx.session.welcomeMessageId = welcomeId;
    if (isAdmin(ctx as BotContext, env)) {
      await ctx.reply(
        "Разделы администратора — кнопки внизу закреплены.",
        adminPinnedReplyKb()
      );
    }
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      [
        "Команды:",
        "/start — главное меню (приветствие, услуги, запись)",
        "/mybooking — моя текущая запись",
        "",
        "По вопросам записи можно написать прямо здесь — мастер ответит, когда будет на связи.",
      ].join("\n")
    );
  });

  bot.action("menu:main", async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCbQuery();
    ctx.session ??= {};
    delete ctx.session.selectedServiceId;
    const msg = ctx.callbackQuery?.message;
    const wid = ctx.session.welcomeMessageId;
    if (msg && wid !== undefined && msg.message_id !== wid) {
      await deleteMessageIfNotWelcome(ctx, msg.message_id);
      return;
    }
    if (msg && wid === undefined) {
      await deleteMessageIfNotWelcome(ctx, msg.message_id);
    }
    const mid = await sendMainWelcome(ctx, supabase, env.PUBLIC_BASE_URL);
    if (mid) ctx.session.welcomeMessageId = mid;
  });

  bot.action("menu:services", async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCbQuery();
    ctx.session ??= {};
    const rows: ReturnType<typeof Markup.button.callback>[][] = [];
    for (let i = 0; i < SERVICES.length; i += 2) {
      const a = SERVICES[i];
      const b = SERVICES[i + 1];
      const line = [
        Markup.button.callback(
          telegramInlineButtonText(a.title),
          `svc:${a.id}`
        ),
      ];
      if (b) {
        line.push(
          Markup.button.callback(
            telegramInlineButtonText(b.title),
            `svc:${b.id}`
          )
        );
      }
      rows.push(line);
    }
    rows.push([Markup.button.callback("« На главную", "menu:main")]);
    const text = "Выберите услугу:";
    const msg = ctx.callbackQuery?.message;
    const kb = Markup.inlineKeyboard(rows);
    const wid = ctx.session.welcomeMessageId;
    if (msg && wid !== undefined && msg.message_id === wid) {
      await ctx.reply(text, kb);
    } else if (msg) {
      await deleteMessageIfNotWelcome(ctx, msg.message_id);
      await ctx.reply(text, kb);
    } else {
      await ctx.reply(text, kb);
    }
  });

  bot.action(/^svc:([a-z_]+)$/, async (ctx) => {
    const id = ctx.match[1];
    const s = getServiceById(id);
    if (!s) {
      await ctx.answerCbQuery("Неизвестная услуга");
      return;
    }
    await ctx.answerCbQuery();
    ctx.session ??= {};
    ctx.session.selectedServiceId = id;
    const prev = ctx.callbackQuery?.message;
    if (prev) {
      await deleteMessageIfNotWelcome(ctx, prev.message_id);
    }
    const prices = await getServicePrices(supabase);
    const price = prices[s.id] ?? 10;
    const caption = [
      `<b>${escapeHtml(s.title)}</b>`,
      "",
      escapeHtml(s.description),
      "",
      `Цена: ${price} ₽ (информация; запись и предоплата — «Записаться»).`,
    ].join("\n");
    const img = assetPath("services", s.imageFile);
    const extra = {
      parse_mode: "HTML" as const,
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("« Услуги", "menu:services"),
          Markup.button.callback("Записаться", "book"),
        ],
      ]),
    };
    const remoteUrl = publicAssetUrl(env.PUBLIC_BASE_URL, "services", s.imageFile);
    if (fileExists(img)) {
      await ctx.replyWithPhoto({ source: img }, { caption, ...extra });
    } else if (remoteUrl) {
      try {
        await ctx.replyWithPhoto({ url: remoteUrl }, { caption, ...extra });
      } catch (e) {
        console.warn(
          `Услуга ${s.id}: нет файла на диске и ошибка URL ${remoteUrl}`,
          e
        );
        await ctx.reply(caption, extra);
      }
    } else {
      console.warn(
        `Услуга ${s.id}: добавьте assets/bot/services/${s.imageFile} в репозиторий`
      );
      await ctx.reply(caption, extra);
    }
  });

  bot.command("mybooking", async (ctx) => {
    if (!ctx.from) return;
    const client = await getClientByTelegramId(supabase, ctx.from.id);
    if (!client) {
      await ctx.reply("Активных записей не найдено. Нажмите /start.");
      return;
    }
    const active = await getActiveAppointmentForClient(supabase, client.id);
    if (!active) {
      await ctx.reply("Активных записей нет.");
      return;
    }
    const when = formatSlotRu(active.slots.starts_at);
    if (active.status === "pending_payment") {
      await replyPendingPayment(ctx, active, env, supabase, bot);
      return;
    }
    await ctx.reply(`Подтверждённая запись: ${when}.`);
  });

  bot.action("book", async (ctx) => {
    if (!ctx.from) return;
    const slots = await listAvailableSlots(supabase, 50, {
      start: env.WORKING_HOURS_START,
      end: env.WORKING_HOURS_END,
    });
    if (slots.length === 0) {
      await ctx.answerCbQuery("Свободных слотов нет");
      const empty =
        "Свободных слотов сейчас нет. Возможные причины:\n" +
        "• мастер ещё не добавил расписание в боте;\n" +
        "• выбран выходной день (мастер отметил день в «Админка → Выходные»);\n" +
        "• все окна уже заняты.\n\n" +
        `Мастеру: слоты только в графике ${env.WORKING_HOURS_START}–${env.WORKING_HOURS_END} (Иркутск). Админка → «Слоты и записи» → «Добавить слот», или:\n` +
        "/добавить_слот 15-04-2026 14:00 60\n\n" +
        "Клиентам: напишите нам в этот чат или зайдите позже.";
      const msg = ctx.callbackQuery?.message;
      if (msg && "photo" in msg) {
        await ctx.reply(empty);
      } else if (ctx.callbackQuery && msg && "text" in msg) {
        await ctx.editMessageText(empty);
      }
      return;
    }

    const rows = buildBookDateRows(slots);
    await answerAndEditOrReplyText(
      ctx,
      [
        "📅 Выберите дату приёма (Иркутск):",
        "",
        "Показаны 7 ближайших дней. Если на день нет мест — так и отмечено. После выбора даты откроются свободные окна.",
      ].join("\n"),
      Markup.inlineKeyboard(rows)
    );
  });

  bot.action(/^bookunavail:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    await ctx.answerCbQuery({
      text: "На эту дату нет свободных окон. Выберите другой день.",
      show_alert: false,
    });
  });

  bot.action(/^bookday:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    if (!ctx.from) return;
    const ymd = ctx.match[1];
    const slots = await listAvailableSlots(supabase, 50, {
      start: env.WORKING_HOURS_START,
      end: env.WORKING_HOURS_END,
    });
    const daySlots = slots
      .filter((s) => formatIrkutskDateOnly(s.starts_at) === ymd)
      .sort(
        (a, b) =>
          new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
      );
    if (daySlots.length === 0) {
      await ctx.answerCbQuery("На этот день слотов уже нет");
      return;
    }
    await ctx.answerCbQuery();
    const timeButtons = daySlots.map((s) =>
      Markup.button.callback(
        telegramInlineButtonText(formatIrkutskTimeHm(s.starts_at)),
        `slot:${s.id}`
      )
    );
    const timeRows: ReturnType<typeof Markup.button.callback>[][] = [];
    for (let i = 0; i < timeButtons.length; i += 3) {
      timeRows.push(timeButtons.slice(i, i + 3));
    }
    timeRows.push([Markup.button.callback("« К выбору даты", "book")]);
    const text = [
      `📅 ${formatWeekdayDdMmYyyyFromYmd(ymd)}`,
      "",
      "🕐 Выберите время сеанса:",
    ].join("\n");
    const msg = ctx.callbackQuery?.message;
    const kb = Markup.inlineKeyboard(timeRows);
    if (msg && "photo" in msg) {
      await ctx.reply(text, kb);
    } else if (msg && "text" in msg) {
      await ctx.editMessageText(text, kb);
    }
  });

  bot.action("book:noop", async (ctx) => {
    await ctx.answerCbQuery();
  });

  bot.action(/^rem:skip1h:([0-9a-f-]{36})$/i, async (ctx) => {
    if (!ctx.from) return;
    const apptId = ctx.match[1];
    const apt = await getAppointmentById(supabase, apptId);
    if (!apt || apt.status !== "confirmed") {
      await ctx.answerCbQuery("Запись не найдена");
      return;
    }
    if (ctx.from.id !== apt.clients.telegram_user_id) {
      await ctx.answerCbQuery("Это не ваша запись");
      return;
    }
    try {
      await setReminderSkipOneHour(supabase, apptId);
    } catch (e) {
      console.error(e);
      await ctx.answerCbQuery(
        "Не удалось сохранить. Обновите бота (миграция БД) или напишите администратору."
      );
      return;
    }
    await ctx.answerCbQuery("Готово! Напоминание за час не отправим. 👍");
  });

  bot.action(/^slot:([0-9a-f-]{36})$/i, async (ctx) => {
    const slotId = ctx.match[1];
    const slot = await getSlot(supabase, slotId);
    if (!slot || !slot.is_published || slot.is_booked) {
      await ctx.answerCbQuery("Слот недоступен");
      const err =
        "Этот слот уже занят или снят. Нажмите /start и выберите другое время.";
      const msg = ctx.callbackQuery?.message;
      if (msg && "photo" in msg) {
        await ctx.reply(err);
      } else if (msg && "text" in msg) {
        await ctx.editMessageText(err);
      }
      return;
    }

    ctx.session ??= {};
    ctx.session.slotId = slotId;
    ctx.session.step = "name";
    await ctx.answerCbQuery();
    const ask = "Отлично. Как к вам обращаться? Отправьте имя одним сообщением.";
    const msg = ctx.callbackQuery?.message;
    if (msg && "photo" in msg) {
      await ctx.reply(ask);
    } else if (msg && "text" in msg) {
      await ctx.editMessageText(ask);
    }
  });

  const adminRootKb = () =>
    Markup.inlineKeyboard([
      [
        Markup.button.callback("Выходные дни", "admin:closure"),
        Markup.button.callback("Цены услуг", "admin:prices"),
      ],
      [
        Markup.button.callback("Слоты и записи", "admin:slots_menu"),
        Markup.button.callback("Справка (текст)", "admin:cmd:help"),
      ],
    ]);

  async function showAdminClosurePanel(ctx: BotContext) {
    let days: string[] = [];
    try {
      days = await listClosureDays(supabase);
    } catch {
      await ctx.reply(
        "Таблица выходных не найдена. Выполните миграцию Supabase: closure_days."
      );
      return;
    }
    const rows: ReturnType<typeof Markup.button.callback>[][] = days.map(
      (d) => [
        Markup.button.callback(
          `✕ ${isoYmdToDdMmYyyy(d)}`,
          `admin:closure:rm:${d}`
        ),
      ]
    );
    rows.push([Markup.button.callback("➕ Добавить день", "admin:closure:add")]);
    rows.push([Markup.button.callback("« Назад", "admin:home")]);
    const text =
      days.length > 0
        ? `Дни без записи (клиенты не видят слоты в эти даты):\n${days.map((d) => isoYmdToDdMmYyyy(d)).join("\n")}`
        : "Выходные дни не заданы. Добавьте дату — в этот день запись через бота недоступна.";
    await ctx.reply(text, Markup.inlineKeyboard(rows));
  }

  async function showAdminPricesPanel(ctx: BotContext) {
    const prices = await getServicePrices(supabase);
    const rows: ReturnType<typeof Markup.button.callback>[][] = [];
    for (let i = 0; i < SERVICES.length; i += 2) {
      const a = SERVICES[i];
      const b = SERVICES[i + 1];
      const line = [
        Markup.button.callback(
          telegramInlineButtonText(
            `${a.title} · ${prices[a.id] ?? 10} ₽`
          ),
          `admin:price:${a.id}`
        ),
      ];
      if (b) {
        line.push(
          Markup.button.callback(
            telegramInlineButtonText(
              `${b.title} · ${prices[b.id] ?? 10} ₽`
            ),
            `admin:price:${b.id}`
          )
        );
      }
      rows.push(line);
    }
    rows.push([Markup.button.callback("« Назад", "admin:home")]);
    await ctx.reply(
      "Цены услуг (информация для клиентов в разделе «Услуги»). Нажмите услугу, чтобы изменить:",
      Markup.inlineKeyboard(rows)
    );
  }

  async function showAdminSlotsMenu(ctx: BotContext) {
    await ctx.reply(
      "Слоты и записи:",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Список слотов", "admin:cmd:slots"),
          Markup.button.callback("Записи 14 дн.", "admin:cmd:bookings"),
        ],
        [Markup.button.callback("Добавить слот", "admin:addslot")],
        [Markup.button.callback("« Назад", "admin:home")],
      ])
    );
  }

  async function showAdminHelpText(ctx: BotContext) {
    await ctx.reply(
      [
        "Команды (есть русские и английские варианты):",
        "/слоты или /slots — список слотов",
        "/добавить_слот или /addslot ДД-ММ-ГГГ ЧЧ:ММ длительность_мин (или кнопка «Добавить слот» в этом разделе)",
        "/записи или /bookings — записи за 14 дней",
        "/отменить или /cancel <uuid записи> — отменить запись",
        "/перенести или /move <uuid записи> <uuid нового слота>",
        "/снять_слот или /unpublishslot <uuid слота> — убрать слот из ленты",
        "/удалить_слот или /deleteslot <uuid слота> — удалить свободный слот",
        "",
        "UUID копируйте из списка записей (/записи) или при необходимости из БД.",
      ].join("\n")
    );
  }

  async function createSlotFromAdminLine(ctx: BotContext, raw: string): Promise<void> {
    const m = raw.match(
      /^(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}:\d{2})\s+(\d+)\s*$/i
    );
    if (!m) {
      await ctx.reply(
        "Формат: ДД-ММ-ГГГ ЧЧ:ММ длительность_мин\nПример: 15-04-2026 14:00 60\n\nОтмена: /admin"
      );
      return;
    }
    try {
      const ymd = `${m[3]}-${m[2]}-${m[1]}`;
      const { starts_at, ends_at } = parseIrkutskStartEnd(
        ymd,
        m[4],
        Number(m[5])
      );
      if (
        !isWithinWorkingHours(
          starts_at,
          env.WORKING_HOURS_START,
          env.WORKING_HOURS_END
        )
      ) {
        await ctx.reply(
          `Начало сеанса вне графика клиники (${env.WORKING_HOURS_START}–${env.WORKING_HOURS_END}, время Иркутска). Выберите другое время.`
        );
        return;
      }
      const { fromInclusive, toExclusive } = irkutskDayUtcRange(ymd);
      const already = await countSlotsStartingInRange(
        supabase,
        fromInclusive,
        toExclusive
      );
      if (already >= env.MAX_SLOTS_PER_DAY) {
        await ctx.reply(
          `На этот день уже ${env.MAX_SLOTS_PER_DAY} слотов (лимит по графику). Удалите слот (/удалить_слот) или выберите другую дату.`
        );
        return;
      }
      const row = await insertSlot(supabase, { starts_at, ends_at });
      if (ctx.session?.step === "admin_addslot") {
        ctx.session = {};
      }
      await ctx.reply(`Слот создан:\n${formatSlotRu(row.starts_at)}`);
    } catch {
      await ctx.reply("Не удалось разобрать дату/время. Проверьте формат.");
    }
  }

  bot.on("text", async (ctx, next) => {
    if (!ctx.from) return next();

    const trimmed = ctx.message.text.trim();
    const step = ctx.session?.step;
    if (isAdmin(ctx as BotContext, env)) {
      const adminPinned: Record<string, () => Promise<void>> = {
        "Выходные дни": () => showAdminClosurePanel(ctx),
        "Цены услуг": () => showAdminPricesPanel(ctx),
        "Слоты и записи": () => showAdminSlotsMenu(ctx),
        Справка: () => showAdminHelpText(ctx),
      };
      const run = adminPinned[trimmed];
      if (run) {
        if (step === "name" || step === "phone" || step === "admin_addslot") {
          ctx.session = {};
        }
        await run();
        return;
      }
    }

    if (
      ctx.session?.step === "admin_closure" &&
      isAdmin(ctx as BotContext, env)
    ) {
      const text = ctx.message.text.trim();
      if (/^\d{2}-\d{2}-\d{4}$/.test(text)) {
        const iso = ddMmYyyyToIsoYmd(text);
        if (!iso) {
          await ctx.reply("Неверная дата. Или /admin — отмена.");
          return;
        }
        try {
          await addClosureDay(supabase, iso);
          ctx.session = {};
          await ctx.reply(
            `Выходной день ${text} сохранён. Клиенты не увидят слоты в эту дату.`
          );
        } catch (e) {
          console.error(e);
          await ctx.reply("Не удалось сохранить. Проверьте миграции БД (таблица closure_days).");
        }
        return;
      }
      await ctx.reply(
        "Укажите дату в формате ДД-ММ-ГГГГ, например 15-04-2026. Или /admin — отмена."
      );
      return;
    }

    if (
      ctx.session?.step === "admin_price" &&
      isAdmin(ctx as BotContext, env) &&
      ctx.session.adminPriceServiceId
    ) {
      const n = parseInt(ctx.message.text.trim().replace(/\s/g, ""), 10);
      if (!Number.isFinite(n) || n < 0) {
        await ctx.reply("Введите целое число рублей (например 10).");
        return;
      }
      const sid = ctx.session.adminPriceServiceId;
      ctx.session = {};
      try {
        await setServicePrice(supabase, sid, n);
        await ctx.reply(`Цена для услуги «${sid}» установлена: ${n} ₽.`);
      } catch (e) {
        console.error(e);
        await ctx.reply("Ошибка сохранения цены.");
      }
      return;
    }

    if (
      ctx.session?.step === "admin_addslot" &&
      isAdmin(ctx as BotContext, env)
    ) {
      const text = ctx.message.text.trim();
      if (text.startsWith("/")) {
        return next();
      }
      await createSlotFromAdminLine(ctx, text);
      return;
    }

    if (!ctx.session?.step) {
      if (ctx.message.text.startsWith("/")) return next();
      return next();
    }

    const text = ctx.message.text.trim();
    if (text.startsWith("/")) {
      return next();
    }
    if (ctx.session.step === "name") {
      if (text.length < 2) {
        await ctx.reply("Пожалуйста, укажите имя (хотя бы 2 буквы).");
        return;
      }
      ctx.session.tempName = text;
      ctx.session.step = "phone";
      await ctx.reply(
        "Укажите телефон для связи (в любом удобном формате одним сообщением)."
      );
      return;
    }

    if (ctx.session.step === "phone") {
      const phone = text;
      const slotId = ctx.session.slotId;
      const name = ctx.session.tempName;
      if (!slotId || !name) {
        ctx.session = {};
        await ctx.reply("Сессия сброшена. Нажмите /start.");
        return;
      }

      const slot = await getSlot(supabase, slotId);
      if (!slot || !slot.is_published || slot.is_booked) {
        ctx.session = {};
        await ctx.reply("Слот больше недоступен. Нажмите /start и выберите другое время.");
        return;
      }

      const client = await upsertClient(supabase, {
        telegram_user_id: ctx.from.id,
        telegram_username: ctx.from.username ?? null,
        full_name: name,
        phone,
      });

      const idempotencyKey = randomUUID();
      const notes = ctx.session.selectedServiceId
        ? JSON.stringify({ service_id: ctx.session.selectedServiceId })
        : null;
      let appointment;
      try {
        appointment = await createPendingAppointment(supabase, {
          slot_id: slotId,
          client_id: client.id,
          idempotency_key: idempotencyKey,
          notes,
        });
      } catch {
        ctx.session = {};
        await ctx.reply(
          "К сожалению, этот слот только что заняли. Нажмите /start и выберите другое время."
        );
        return;
      }

      const returnUrl = `https://t.me/${env.BOT_USERNAME}`;
      let payment;
      try {
        payment = await createYookassaPayment(env, {
          amountRub: appointment.prepayment_rub,
          returnUrl,
          description: `Предоплата за сеанс «Хиджама №1» (${formatShortRu(slot.starts_at)})`,
          idempotenceKey: idempotencyKey,
          metadata: {
            appointment_id: appointment.id,
            telegram_user_id: String(ctx.from.id),
          },
        });
      } catch (e) {
        console.error(e);
        ctx.session = {};
        await ctx.reply(
          "Не удалось создать платёж. Попробуйте позже или напишите администратору."
        );
        return;
      }

      await setYookassaPaymentInfo(supabase, appointment.id, {
        paymentId: payment.id,
        confirmationUrl: payment.confirmationUrl,
      });

      const procLine = await formatSelectedProcedureLine(
        supabase,
        appointment.notes
      );
      ctx.session = {};
      await ctx.reply(
        [
          `Спасибо! Осталось внести предоплату ${appointment.prepayment_rub} ₽.`,
          ...(procLine ? [procLine] : []),
          "",
          "После оплаты вы вернётесь в этот чат — придёт сообщение с подтверждением записи.",
          "",
          "Если оплата прошла, а сообщение не пришло — нажмите /start или отправьте любое сообщение боту.",
        ].join("\n"),
        Markup.inlineKeyboard([
          [
            Markup.button.url(
              `Оплатить ${appointment.prepayment_rub} ₽`,
              payment.confirmationUrl
            ),
          ],
        ])
      );
      return;
    }

    return next();
  });

  bot.command("admin", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
    if (ctx.session) {
      if (ctx.session.step === "admin_price") {
        delete ctx.session.adminPriceServiceId;
      }
      if (
        ctx.session.step === "admin_addslot" ||
        ctx.session.step === "admin_closure" ||
        ctx.session.step === "admin_price"
      ) {
        delete ctx.session.step;
      }
    }
    await ctx.reply(
      "Панель администратора. Кнопки внизу закреплены — быстрый доступ к разделам.",
      adminPinnedReplyKb()
    );
    await ctx.reply("Панель администратора:", adminRootKb());
  });

  bot.action("admin:home", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.answerCbQuery("Нет доступа");
      return;
    }
    await ctx.answerCbQuery();
    await ctx.editMessageText("Панель администратора:", adminRootKb());
  });

  bot.action("admin:closure", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.answerCbQuery("Нет доступа");
      return;
    }
    await ctx.answerCbQuery();
    await showAdminClosurePanel(ctx);
  });

  bot.action(/^admin:closure:rm:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.answerCbQuery("Нет доступа");
      return;
    }
    const day = ctx.match[1];
    await ctx.answerCbQuery();
    try {
      await removeClosureDay(supabase, day);
      await ctx.reply(
        `День ${isoYmdToDdMmYyyy(day)} удалён из выходных.`
      );
    } catch (e) {
      console.error(e);
      await ctx.reply("Не удалось удалить.");
    }
  });

  bot.action("admin:closure:add", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.answerCbQuery("Нет доступа");
      return;
    }
    await ctx.answerCbQuery();
    ctx.session ??= {};
    ctx.session.step = "admin_closure";
    await ctx.reply(
      "Введите дату выходного дня в формате ДД-ММ-ГГГГ (календарь Иркутска для слотов), например 01-05-2026."
    );
  });

  bot.action("admin:prices", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.answerCbQuery("Нет доступа");
      return;
    }
    await ctx.answerCbQuery();
    await showAdminPricesPanel(ctx);
  });

  bot.action(/^admin:price:([a-z_]+)$/, async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.answerCbQuery("Нет доступа");
      return;
    }
    const sid = ctx.match[1];
    if (!getServiceById(sid)) {
      await ctx.answerCbQuery("Неизвестная услуга");
      return;
    }
    await ctx.answerCbQuery();
    ctx.session ??= {};
    ctx.session.step = "admin_price";
    ctx.session.adminPriceServiceId = sid;
    await ctx.reply(`Введите цену в рублях для «${sid}» одним числом (например 10).`);
  });

  bot.action("admin:slots_menu", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.answerCbQuery("Нет доступа");
      return;
    }
    await ctx.answerCbQuery();
    await showAdminSlotsMenu(ctx);
  });

  bot.action("admin:cmd:slots", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.answerCbQuery("Нет доступа");
      return;
    }
    await ctx.answerCbQuery();
    const from = new Date().toISOString();
    const slots = await listSlotsAdmin(supabase, from);
    if (slots.length === 0) {
      await ctx.reply("Слотов не найдено.");
      return;
    }
    const lines = await Promise.all(
      slots.map(async (s) => {
        const { data: pend } = await supabase
          .from("appointments")
          .select("id")
          .eq("slot_id", s.id)
          .eq("status", "pending_payment")
          .maybeSingle();
        const pending = !!pend;
        const st = s.is_booked
          ? "занят (подтверждён)"
          : pending
            ? "ожидает оплату"
            : "свободен";
        const pub = s.is_published ? "" : " [не в ленте]";
        return `${formatShortRu(s.starts_at)} — ${st}${pub}`;
      })
    );
    await ctx.reply(lines.join("\n\n"));
  });

  bot.action("admin:cmd:bookings", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.answerCbQuery("Нет доступа");
      return;
    }
    await ctx.answerCbQuery();
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 14 * 86400_000).toISOString();
    const list = await listAppointmentsInSlotRange(supabase, from, to);
    if (list.length === 0) {
      await ctx.reply("Записей в ближайшие 14 дней нет.");
      return;
    }
    const text = list.map((a) => formatAdminBookingMessage(a)).join("\n\n");
    await ctx.reply(text);
  });

  bot.action("admin:cmd:help", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.answerCbQuery("Нет доступа");
      return;
    }
    await ctx.answerCbQuery();
    await showAdminHelpText(ctx);
  });

  bot.action("admin:addslot", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.answerCbQuery("Нет доступа");
      return;
    }
    await ctx.answerCbQuery();
    ctx.session ??= {};
    ctx.session.step = "admin_addslot";
    await ctx.reply(
      "Отправьте одной строкой: ДД-ММ-ГГГ ЧЧ:ММ длительность_мин\nПример: 15-04-2026 14:00 60\n\nОтмена: /admin"
    );
  });

  bot.command(["slots", "слоты"], async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
    const from = new Date().toISOString();
    const slots = await listSlotsAdmin(supabase, from);
    if (slots.length === 0) {
      await ctx.reply("Слотов не найдено.");
      return;
    }
    const lines = await Promise.all(
      slots.map(async (s) => {
        const { data: pend } = await supabase
          .from("appointments")
          .select("id")
          .eq("slot_id", s.id)
          .eq("status", "pending_payment")
          .maybeSingle();
        const pending = !!pend;
        const st = s.is_booked
          ? "занят (подтверждён)"
          : pending
            ? "ожидает оплату"
            : "свободен";
        const pub = s.is_published ? "" : " [не в ленте]";
        return `${formatShortRu(s.starts_at)} — ${st}${pub}`;
      })
    );
    await ctx.reply(lines.join("\n\n"));
  });

  bot.command(["addslot", "добавить_слот"], async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
    const raw = ctx.message.text.replace(/^\/\S+\s*/, "").trim();
    if (!raw) {
      ctx.session ??= {};
      ctx.session.step = "admin_addslot";
      await ctx.reply(
        "Отправьте одной строкой: ДД-ММ-ГГГ ЧЧ:ММ длительность_мин\nПример: 15-04-2026 14:00 60\n\nОтмена: /admin"
      );
      return;
    }
    await createSlotFromAdminLine(ctx, raw);
  });

  bot.command(["bookings", "записи"], async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 14 * 86400_000).toISOString();
    const list = await listAppointmentsInSlotRange(supabase, from, to);
    if (list.length === 0) {
      await ctx.reply("Записей в ближайшие 14 дней нет.");
      return;
    }
    const text = list.map((a) => formatAdminBookingMessage(a)).join("\n\n");
    await ctx.reply(text);
  });

  bot.command(["cancel", "отменить"], async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
    const id = ctx.message.text.split(/\s+/)[1]?.trim();
    if (!id) {
      await ctx.reply(
        "Укажите номер записи (uuid): /отменить <uuid> или /cancel <uuid>"
      );
      return;
    }
    const apt = await cancelAppointmentByAdmin(supabase, id);
    if (!apt) {
      await ctx.reply("Запись не найдена.");
      return;
    }
    try {
      await bot.telegram.sendMessage(
        apt.clients.telegram_user_id,
        "Ваша запись отменена администратором. Если нужно другое время — нажмите /start и выберите слот снова."
      );
    } catch (e) {
      console.error("notify cancel client", e);
    }
    await ctx.reply("Запись отменена, клиент уведомлён (если бот не заблокирован).");
  });

  bot.command(["move", "перенести"], async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
    const parts = ctx.message.text.split(/\s+/);
    const aid = parts[1];
    const sid = parts[2];
    if (!aid || !sid) {
      await ctx.reply(
        "Формат: /перенести <uuid записи> <uuid нового слота>\n(англ.: /move …)"
      );
      return;
    }
    const res = await moveAppointmentToSlot(supabase, aid, sid);
    if (!res.ok) {
      await ctx.reply(`Не удалось перенести: ${res.reason}`);
      return;
    }
    const updated = await getAppointmentById(supabase, aid);
    if (updated) {
      try {
        await bot.telegram.sendMessage(
          updated.clients.telegram_user_id,
          `Ваш сеанс перенесён на: ${formatSlotRu(updated.slots.starts_at)}`
        );
      } catch (e) {
        console.error("notify move client", e);
      }
    }
    await ctx.reply("Перенос выполнен.");
  });

  bot.command(["unpublishslot", "снять_слот"], async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
    const id = ctx.message.text.split(/\s+/)[1]?.trim();
    if (!id) {
      await ctx.reply(
        "Формат: /снять_слот <uuid слота>\n(англ.: /unpublishslot …)"
      );
      return;
    }
    await setSlotPublished(supabase, id, false);
    await ctx.reply("Слот снят с публикации (если существовал).");
  });

  bot.command(["deleteslot", "удалить_слот"], async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
    const id = ctx.message.text.split(/\s+/)[1]?.trim();
    if (!id) {
      await ctx.reply(
        "Формат: /удалить_слот <uuid слота>\n(англ.: /deleteslot …)"
      );
      return;
    }
    const r = await deleteSlotIfFree(supabase, id);
    if (!r.ok) {
      await ctx.reply(r.reason ?? "Не удалось удалить");
      return;
    }
    await ctx.reply("Слот удалён.");
  });

  return bot;
}
