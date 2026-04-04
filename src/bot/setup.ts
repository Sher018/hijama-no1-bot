import { Telegraf, session, Markup } from "telegraf";
import type { Context } from "telegraf";
import { randomUUID } from "node:crypto";
import type { Env } from "../config/env.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppointmentWithRelations } from "../db/types.js";
import { upsertClient, getClientByTelegramId } from "../services/clientsRepo.js";
import {
  createPendingAppointment,
  setYookassaPaymentInfo,
  getActiveAppointmentForClient,
  getAppointmentById,
  cancelAppointmentByAdmin,
  moveAppointmentToSlot,
  listConfirmedAppointments,
} from "../services/appointmentsRepo.js";
import {
  listAvailableSlots,
  getSlot,
  insertSlot,
  listSlotsAdmin,
  deleteSlotIfFree,
  setSlotPublished,
} from "../services/slotsRepo.js";
import {
  getServicePrices,
  setServicePrice,
} from "../services/settingsRepo.js";
import { createYookassaPayment } from "../services/yookassaClient.js";
import { formatShortRu, formatSlotRu } from "../util/time.js";
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
} from "./content/servicesCatalog.js";

interface SessionData {
  step?: "name" | "phone" | "admin_closure" | "admin_price";
  slotId?: string;
  tempName?: string;
  adminPriceServiceId?: string;
}

type BotContext = Context & { session?: SessionData };

/** Только inline-клавиатура, как у editMessageText (без deep-import из telegraf/typings). */
type InlineMessageExtra = NonNullable<
  Parameters<BotContext["editMessageText"]>[1]
>;

function isAdmin(ctx: BotContext, env: Env): boolean {
  return ctx.from?.id === env.ADMIN_TELEGRAM_ID;
}

async function answerAndEditOrReplyText(
  ctx: BotContext,
  text: string,
  extra?: InlineMessageExtra
): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  await ctx.answerCbQuery();
  if (msg && "photo" in msg) {
    await ctx.reply(text, extra as Parameters<BotContext["reply"]>[1]);
  } else if (ctx.callbackQuery && msg && "text" in msg) {
    await ctx.editMessageText(text, extra);
  }
}

async function replyPendingPayment(
  ctx: BotContext,
  active: AppointmentWithRelations
): Promise<void> {
  const lines = [
    "У вас есть запись, ожидающая оплаты.",
    `Время: ${formatSlotRu(active.slots.starts_at)}`,
    "",
    "После оплаты вы вернётесь в бот — придёт подтверждение.",
  ];
  const url = active.yookassa_confirmation_url;
  if (url) {
    await ctx.reply(
      lines.join("\n"),
      Markup.inlineKeyboard([[Markup.button.url("Оплатить 500 ₽", url)]])
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

function parseIrkutskStartEnd(
  dateStr: string,
  timeStr: string,
  durationMin: number
): { starts_at: string; ends_at: string } {
  const iso = `${dateStr}T${timeStr.length === 5 ? `${timeStr}:00` : timeStr}+08:00`;
  const starts = new Date(iso);
  if (Number.isNaN(starts.getTime())) {
    throw new Error("bad datetime");
  }
  const ends = new Date(starts.getTime() + durationMin * 60_000);
  return { starts_at: starts.toISOString(), ends_at: ends.toISOString() };
}

export function buildBot(env: Env, supabase: SupabaseClient): Telegraf<BotContext> {
  const bot = new Telegraf<BotContext>(env.BOT_TOKEN);

  bot.use(
    session({
      defaultSession: (): SessionData => ({}),
    })
  );

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
        await replyPendingPayment(ctx, active);
        return;
      }
      if (active?.status === "confirmed") {
        await ctx.reply(
          [
            "У вас уже есть подтверждённая запись:",
            formatSlotRu(active.slots.starts_at),
            "",
            "Перенос и отмена — по согласованию с мастером (напишите в этот чат).",
          ].join("\n")
        );
        return;
      }
    }

    await sendMainWelcome(ctx, supabase, env.PUBLIC_BASE_URL);
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
    await sendMainWelcome(ctx, supabase, env.PUBLIC_BASE_URL);
  });

  bot.action("menu:services", async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCbQuery();
    const rows: ReturnType<typeof Markup.button.callback>[][] = [];
    for (let i = 0; i < SERVICES.length; i += 2) {
      const a = SERVICES[i];
      const b = SERVICES[i + 1];
      const line = [
        Markup.button.callback(a.buttonLabel, `svc:${a.id}`),
      ];
      if (b) line.push(Markup.button.callback(b.buttonLabel, `svc:${b.id}`));
      rows.push(line);
    }
    rows.push([Markup.button.callback("« На главную", "menu:main")]);
    const text = "Выберите услугу:";
    const msg = ctx.callbackQuery?.message;
    const kb = Markup.inlineKeyboard(rows);
    if (msg && "photo" in msg) {
      await ctx.reply(text, kb);
    } else if (ctx.callbackQuery && msg && "text" in msg) {
      await ctx.editMessageText(text, kb);
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
      await replyPendingPayment(ctx, active);
      return;
    }
    await ctx.reply(`Подтверждённая запись: ${when}.`);
  });

  bot.action("book", async (ctx) => {
    if (!ctx.from) return;
    const slots = await listAvailableSlots(supabase, 15, {
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
        `Мастеру: слоты только в графике ${env.WORKING_HOURS_START}–${env.WORKING_HOURS_END} (Иркутск). /admin или:\n` +
        "/addslot 2026-04-15 14:00 60\n\n" +
        "Клиентам: напишите нам в этот чат или зайдите позже.";
      const msg = ctx.callbackQuery?.message;
      if (msg && "photo" in msg) {
        await ctx.reply(empty);
      } else if (ctx.callbackQuery && msg && "text" in msg) {
        await ctx.editMessageText(empty);
      }
      return;
    }

    const rows = slots.map((s) => [
      Markup.button.callback(formatShortRu(s.starts_at), `slot:${s.id}`),
    ]);
    rows.push([Markup.button.callback("« Назад", "menu:main")]);
    await answerAndEditOrReplyText(
      ctx,
      "Выберите время сеанса:",
      Markup.inlineKeyboard(rows)
    );
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

  bot.on("text", async (ctx, next) => {
    if (!ctx.from) return next();

    if (
      ctx.session?.step === "admin_closure" &&
      isAdmin(ctx as BotContext, env)
    ) {
      const text = ctx.message.text.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        try {
          await addClosureDay(supabase, text);
          ctx.session = {};
          await ctx.reply(`Выходной день ${text} сохранён. Клиенты не увидят слоты в эту дату.`);
        } catch (e) {
          console.error(e);
          await ctx.reply("Не удалось сохранить. Проверьте миграции БД (таблица closure_days).");
        }
        return;
      }
      await ctx.reply("Укажите дату в формате ГГГГ-ММ-ДД, например 2026-04-15. Или /admin — отмена.");
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
      let appointment;
      try {
        appointment = await createPendingAppointment(supabase, {
          slot_id: slotId,
          client_id: client.id,
          idempotency_key: idempotencyKey,
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

      ctx.session = {};
      await ctx.reply(
        [
          "Спасибо! Осталось внести предоплату 500 ₽.",
          `Стоимость сеанса на месте: ${appointment.session_price_min_rub}–${appointment.session_price_max_rub} ₽.`,
          "",
          "После оплаты вы вернётесь в этот чат — придёт сообщение с подтверждением записи.",
        ].join("\n"),
        Markup.inlineKeyboard([
          [Markup.button.url("Оплатить 500 ₽", payment.confirmationUrl)],
        ])
      );
      return;
    }

    return next();
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

  bot.command("admin", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
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
      (d) => [Markup.button.callback(`✕ ${d}`, `admin:closure:rm:${d}`)]
    );
    rows.push([Markup.button.callback("➕ Добавить день", "admin:closure:add")]);
    rows.push([Markup.button.callback("« Назад", "admin:home")]);
    const text =
      days.length > 0
        ? `Дни без записи (клиенты не видят слоты в эти даты):\n${days.join("\n")}`
        : "Выходные дни не заданы. Добавьте дату — в этот день запись через бота недоступна.";
    await ctx.reply(text, Markup.inlineKeyboard(rows));
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
      await ctx.reply(`День ${day} удалён из выходных.`);
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
      "Введите дату выходного дня в формате ГГГГ-ММ-ДД (по календарю Иркутска для слотов), например 2026-05-01."
    );
  });

  bot.action("admin:prices", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.answerCbQuery("Нет доступа");
      return;
    }
    await ctx.answerCbQuery();
    const prices = await getServicePrices(supabase);
    const rows: ReturnType<typeof Markup.button.callback>[][] = [];
    for (let i = 0; i < SERVICES.length; i += 2) {
      const a = SERVICES[i];
      const b = SERVICES[i + 1];
      const line = [
        Markup.button.callback(
          `${a.buttonLabel} · ${prices[a.id] ?? 10} ₽`,
          `admin:price:${a.id}`
        ),
      ];
      if (b) {
        line.push(
          Markup.button.callback(
            `${b.buttonLabel} · ${prices[b.id] ?? 10} ₽`,
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
    await ctx.reply(
      "Слоты и записи:",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Список слотов", "admin:cmd:slots"),
          Markup.button.callback("Записи 14 дн.", "admin:cmd:bookings"),
        ],
        [Markup.button.callback("« Назад", "admin:home")],
      ])
    );
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
        return `${formatShortRu(s.starts_at)} — ${st}${pub}\nid: ${s.id}`;
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
    const list = await listConfirmedAppointments(supabase, from, to);
    if (list.length === 0) {
      await ctx.reply("Подтверждённых записей в ближайшие 14 дней нет.");
      return;
    }
    const text = list
      .map(
        (a) =>
          `${formatSlotRu(a.slots.starts_at)}\n${a.clients.full_name ?? "—"} / ${a.clients.phone ?? "—"}\nзапись: ${a.id}`
      )
      .join("\n\n");
    await ctx.reply(text);
  });

  bot.action("admin:cmd:help", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.answerCbQuery("Нет доступа");
      return;
    }
    await ctx.answerCbQuery();
    await ctx.reply(
      [
        "Текстовые команды (дублируют кнопки):",
        "/slots — слоты",
        "/addslot ГГГГ-ММ-ДД ЧЧ:ММ длительность_мин",
        "/bookings — записи 14 дней",
        "/cancel uuid — отменить запись",
        "/move uuid_записи uuid_слота — перенос",
        "/unpublishslot uuid — снять слот с публикации",
        "/deleteslot uuid — удалить свободный слот",
        "",
        "Приветствие: settings.welcome_text JSON {\"text\":\"...\"}.",
      ].join("\n")
    );
  });

  bot.command("slots", async (ctx) => {
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
        return `${formatShortRu(s.starts_at)} — ${st}${pub}\nid: ${s.id}`;
      })
    );
    await ctx.reply(lines.join("\n\n"));
  });

  bot.command("addslot", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
    const raw = ctx.message.text.replace(/^\/addslot\s*/i, "").trim();
    const m = raw.match(
      /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s+(\d+)\s*$/i
    );
    if (!m) {
      await ctx.reply(
        "Формат: /addslot ГГГГ-ММ-ДД ЧЧ:ММ длительность_мин\nПример: /addslot 2026-04-10 14:00 60"
      );
      return;
    }
    try {
      const { starts_at, ends_at } = parseIrkutskStartEnd(m[1], m[2], Number(m[3]));
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
      const row = await insertSlot(supabase, { starts_at, ends_at });
      await ctx.reply(`Слот создан:\n${formatSlotRu(row.starts_at)}\nid: ${row.id}`);
    } catch {
      await ctx.reply("Не удалось разобрать дату/время. Проверьте формат.");
    }
  });

  bot.command("bookings", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 14 * 86400_000).toISOString();
    const list = await listConfirmedAppointments(supabase, from, to);
    if (list.length === 0) {
      await ctx.reply("Подтверждённых записей в ближайшие 14 дней нет.");
      return;
    }
    const text = list
      .map(
        (a) =>
          `${formatSlotRu(a.slots.starts_at)}\n${a.clients.full_name ?? "—"} / ${a.clients.phone ?? "—"}\nзапись: ${a.id}`
      )
      .join("\n\n");
    await ctx.reply(text);
  });

  bot.command("cancel", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
    const id = ctx.message.text.split(/\s+/)[1]?.trim();
    if (!id) {
      await ctx.reply("Укажите ID записи: /cancel и uuid через пробел.");
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

  bot.command("move", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
    const parts = ctx.message.text.split(/\s+/);
    const aid = parts[1];
    const sid = parts[2];
    if (!aid || !sid) {
      await ctx.reply("Формат: /move uuid_записи uuid_нового_слота");
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

  bot.command("unpublishslot", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
    const id = ctx.message.text.split(/\s+/)[1]?.trim();
    if (!id) {
      await ctx.reply("Формат: /unpublishslot uuid_слота");
      return;
    }
    await setSlotPublished(supabase, id, false);
    await ctx.reply("Слот снят с публикации (если существовал).");
  });

  bot.command("deleteslot", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
    const id = ctx.message.text.split(/\s+/)[1]?.trim();
    if (!id) {
      await ctx.reply("Формат: /deleteslot uuid_слота");
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
