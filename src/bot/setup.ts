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
import { createYookassaPayment } from "../services/yookassaClient.js";
import { formatShortRu, formatSlotRu } from "../util/time.js";

interface SessionData {
  step?: "name" | "phone";
  slotId?: string;
  tempName?: string;
}

type BotContext = Context & { session?: SessionData };

const WELCOME = [
  "Ассаляму алейкум! Вы в боте клиники «Хиджама №1» (Иркутск).",
  "",
  "Здесь можно выбрать удобное время сеанса и внести предоплату 500 ₽. Полная стоимость сеанса оплачивается на месте (3500–6000 ₽ в зависимости от программы).",
  "",
  "Нажмите «Записаться», чтобы увидеть свободные слоты.",
].join("\n");

function isAdmin(ctx: BotContext, env: Env): boolean {
  return ctx.from?.id === env.ADMIN_TELEGRAM_ID;
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

    await ctx.reply(
      WELCOME,
      Markup.inlineKeyboard([[Markup.button.callback("Записаться", "book")]])
    );
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      [
        "Команды:",
        "/start — главное меню",
        "/mybooking — моя текущая запись",
        "",
        "По вопросам записи можно написать прямо здесь — мастер ответит, когда будет на связи.",
      ].join("\n")
    );
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
    const slots = await listAvailableSlots(supabase, 15);
    if (slots.length === 0) {
      await ctx.answerCbQuery("Свободных слотов нет");
      await ctx.editMessageText(
        "Сейчас нет свободных слотов. Загляните позже или напишите нам — мы подберём время."
      );
      return;
    }

    const rows = slots.map((s) => [
      Markup.button.callback(formatShortRu(s.starts_at), `slot:${s.id}`),
    ]);
    await ctx.editMessageText("Выберите время сеанса:", {
      ...Markup.inlineKeyboard(rows),
    });
    await ctx.answerCbQuery();
  });

  bot.action(/^slot:([0-9a-f-]{36})$/i, async (ctx) => {
    const slotId = ctx.match[1];
    const slot = await getSlot(supabase, slotId);
    if (!slot || !slot.is_published || slot.is_booked) {
      await ctx.answerCbQuery("Слот недоступен");
      await ctx.editMessageText(
        "Этот слот уже занят или снят. Нажмите /start и выберите другое время."
      );
      return;
    }

    ctx.session ??= {};
    ctx.session.slotId = slotId;
    ctx.session.step = "name";
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      "Отлично. Как к вам обращаться? Отправьте имя одним сообщением."
    );
  });

  bot.on("text", async (ctx, next) => {
    if (!ctx.session?.step || !ctx.from) {
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

  bot.command("admin", async (ctx) => {
    if (!isAdmin(ctx, env)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }
    await ctx.reply(
      [
        "Админ-команды:",
        "/slots — слоты с текущей даты",
        "/addslot ГГГГ-ММ-ДД ЧЧ:ММ длительность_мин (пример: /addslot 2026-04-10 14:00 60)",
        "/bookings — подтверждённые записи на 14 дней",
        "/cancel uuid_записи — отменить",
        "/move uuid_записи uuid_нового_слота — перенос",
        "/unpublishslot uuid_слота — снять с публикации",
        "/deleteslot uuid_слота — удалить слот (если нет активной записи)",
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
