import { Markup } from "telegraf";
import type { Telegraf } from "telegraf";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../config/env.js";
import { isScheduleAdmin } from "../config/env.js";
import type { BotContext } from "../bot/context.js";
import { listClosureDays, addClosureDay, removeClosureDay } from "../services/closureDaysRepo.js";
import {
  getMasterAvailabilityForDate,
  upsertMasterAvailability,
  type BlockedInterval,
} from "../services/masterAvailabilityRepo.js";
import {
  regenerateSlotsForDay,
  getEffectiveMasterDayConfig,
  computeDesiredSlotStartsHhmm,
  DEFAULT_MASTER_DAY_START,
  DEFAULT_MASTER_DAY_END,
  MASTER_SLOT_DURATION_MIN,
} from "../services/dailySlotsFromMaster.js";
import { listAppointmentsInSlotRange } from "../services/appointmentsRepo.js";
import {
  nextIrkutskDayRangeYmd,
  formatWeekdayDdMmYyyyFromYmd,
  irkutskTodayYmd,
  formatSlotRu,
  irkutskDayUtcRange,
} from "../util/time.js";
import { formatSelectedProcedureLine } from "../services/procedureLine.js";

const DENY_SCHEDULE = "❌ Раздел доступен только администраторам";

/** YYYY-MM-DD → YYYYMMDD для callback_data */
function packYmd(ymd: string): string {
  return ymd.replace(/-/g, "");
}

function unpackYmd(packed: string): string | null {
  if (!/^\d{8}$/.test(packed)) return null;
  return `${packed.slice(0, 4)}-${packed.slice(4, 6)}-${packed.slice(6, 8)}`;
}

/** Экспорт для команды /admin (меню мастера). */
export function masterMainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📅 Мой график на неделю", "sch:week")],
    [Markup.button.callback("➕ Добавить/изменить слоты", "sch:legacy")],
    [Markup.button.callback("🔒 Заблокировать время", "sch:blockmenu")],
    [Markup.button.callback("📋 Все текущие записи", "sch:bookings")],
    [Markup.button.callback("⚙️ Настройки бота", "sch:legacy")],
  ]);
}

async function formatWeekTable(
  supabase: SupabaseClient,
  env: Env
): Promise<string> {
  const days = nextIrkutskDayRangeYmd(7);
  let closure: Set<string>;
  try {
    closure = new Set(await listClosureDays(supabase));
  } catch {
    closure = new Set();
  }

  const lines: string[] = [
    "🤲 <b>График на 7 дней</b> (Иркутск)",
    `Окна по умолчанию: ${DEFAULT_MASTER_DAY_START}–${DEFAULT_MASTER_DAY_END}, слот ${MASTER_SLOT_DURATION_MIN} мин.`,
    "",
  ];

  for (const ymd of days) {
    const cfg = await getEffectiveMasterDayConfig(supabase, ymd, closure);
    const label = formatWeekdayDdMmYyyyFromYmd(ymd);
    const { fromInclusive, toExclusive } = irkutskDayUtcRange(ymd);
    const { data: slots, error } = await supabase
      .from("slots")
      .select("id, starts_at, is_booked")
      .gte("starts_at", fromInclusive)
      .lt("starts_at", toExclusive);
    if (error) throw error;
    const list = (slots ?? []) as {
      id: string;
      starts_at: string;
      is_booked: boolean;
    }[];
    const { data: pend } = await supabase
      .from("appointments")
      .select("slot_id")
      .eq("status", "pending_payment");
    const pendSet = new Set(
      (pend ?? []).map((r: { slot_id: string }) => r.slot_id)
    );
    const free = list.filter(
      (s) => !s.is_booked && !pendSet.has(s.id)
    ).length;

    let status: string;
    if (cfg.isDayOff) {
      status = "❌ выходной";
    } else if (cfg.blocked.length > 0) {
      status = "🔒 частично заблокировано";
    } else {
      status = "✅ работает";
    }

    lines.push(
      `• <b>${label}</b>`,
      `  ⏱ ${cfg.isDayOff ? "—" : `${cfg.startHhmm}–${cfg.endHhmm}`} · свободно слотов: ${cfg.isDayOff ? "0" : String(free)} · ${status}`,
      ""
    );
  }

  lines.push(
    "Выберите день кнопкой ниже или действие в меню мастера."
  );
  return lines.join("\n");
}

function weekDayButtons() {
  const days = nextIrkutskDayRangeYmd(7);
  const rows = days.map((ymd) => {
    const short =
      formatWeekdayDdMmYyyyFromYmd(ymd).split(",")[1]?.trim() ?? ymd;
    return [
      Markup.button.callback(`📌 ${short}`, `sch:d:${packYmd(ymd)}`),
    ];
  });
  rows.push([Markup.button.callback("« В меню мастера", "sch:menu")]);
  return Markup.inlineKeyboard(rows);
}

/** Подписи закреплённых reply-кнопок — те же, что в inline-меню мастера. */
export const PINNED_MASTER_LABELS = {
  week: "📅 Мой график на неделю",
  addSlots: "➕ Добавить/изменить слоты",
  block: "🔒 Заблокировать время",
  bookings: "📋 Все текущие записи",
  settings: "⚙️ Настройки бота",
} as const;

export async function replyPinnedWeekSchedule(
  ctx: BotContext,
  supabase: SupabaseClient,
  env: Env
): Promise<void> {
  await ctx.reply(await formatWeekTable(supabase, env), {
    parse_mode: "HTML",
    ...weekDayButtons(),
  });
}

export async function replyPinnedLegacyHint(ctx: BotContext): Promise<void> {
  await ctx.reply(
    [
      "Классическая панель: выходные, цены, ручной слот, списки.",
      "Используйте закреплённые кнопки внизу или команду /admin после переключения.",
    ].join("\n")
  );
}

export async function replyPinnedBlockMenu(ctx: BotContext): Promise<void> {
  await ctx.reply(
    "🔒 Выберите день — затем можно будет ввести интервал блокировки (например 12:00–14:00).",
    weekDayButtons()
  );
}

export async function replyPinnedBookings(
  ctx: BotContext,
  supabase: SupabaseClient
): Promise<void> {
  const from = new Date().toISOString();
  const to = new Date(Date.now() + 14 * 86400_000).toISOString();
  const list = await listAppointmentsInSlotRange(supabase, from, to);
  if (list.length === 0) {
    await ctx.reply("На ближайшие 14 дней записей нет.");
    return;
  }
  const chunks: string[] = [];
  for (const a of list) {
    const proc = await formatSelectedProcedureLine(supabase, a.notes);
    chunks.push(
      [
        `📌 ${formatSlotRu(a.slots.starts_at)}`,
        `${a.clients.full_name ?? "Клиент"} · ${a.clients.phone ?? "—"}`,
        proc ? proc : "",
        `статус: ${a.status}`,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  await ctx.reply(chunks.join("\n\n"));
}

export function registerMasterSchedule(
  bot: Telegraf<BotContext>,
  env: Env,
  supabase: SupabaseClient
): void {
  /** Текстовый ввод часов / блока (мастер) */
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private") return next();
    const msg = ctx.message;
    if (!msg || !("text" in msg) || typeof msg.text !== "string") {
      return next();
    }
    if (!isScheduleAdmin(ctx, env)) return next();
    const st = ctx.session?.masterSch;
    if (!st?.step || !st.ymd) return next();
    const text = msg.text.trim();
    if (text.startsWith("/")) {
      ctx.session ??= {};
      delete ctx.session.masterSch;
      return next();
    }

    const ymd = st.ymd;
    const today = irkutskTodayYmd();
    if (ymd < today) {
      ctx.session ??= {};
      delete ctx.session.masterSch;
      await ctx.reply("Нельзя менять прошедшие даты.");
      return;
    }

    if (st.step === "hours") {
      const m = text.match(
        /^(\d{1,2}:\d{2})\s*[\-–]\s*(\d{1,2}:\d{2})$/
      );
      if (!m) {
        await ctx.reply(
          "Формат: ЧЧ:ММ–ЧЧ:ММ (например 10:00–21:00). Отмена — любая команда с /"
        );
        return;
      }
      const start = normalizeHhmm(m[1]);
      const end = normalizeHhmm(m[2]);
      if (hhmmToMin(end) <= hhmmToMin(start)) {
        await ctx.reply("Конец должен быть позже начала.");
        return;
      }
      ctx.session ??= {};
      delete ctx.session.masterSch;
      let closure: Set<string>;
      try {
        closure = new Set(await listClosureDays(supabase));
      } catch {
        closure = new Set();
      }
      if (closure.has(ymd)) await removeClosureDay(supabase, ymd);
      try {
        closure = new Set(await listClosureDays(supabase));
      } catch {
        closure = new Set();
      }
      const row = await getMasterAvailabilityForDate(supabase, ymd);
      const blocked = row?.blocked_slots ?? [];
      await upsertMasterAvailability(supabase, {
        date: ymd,
        start_time: start,
        end_time: end,
        is_available: true,
        blocked_slots: blocked,
      });
      await regenerateSlotsForDay(supabase, env, ymd, closure);
      await ctx.reply(
        `✅ График на ${ymd} сохранён: ${start}–${end}. Слоты обновлены (записи не трогали).`
      );
      return;
    }

    if (st.step === "block") {
      const m = text.match(
        /^(\d{1,2}:\d{2})\s*[\-–]\s*(\d{1,2}:\d{2})$/
      );
      if (!m) {
        await ctx.reply(
          "Формат: ЧЧ:ММ–ЧЧ:ММ (например 12:00–14:00). Отмена — команда с /"
        );
        return;
      }
      const bs = normalizeHhmm(m[1]);
      const be = normalizeHhmm(m[2]);
      if (hhmmToMin(be) <= hhmmToMin(bs)) {
        await ctx.reply("Конец интервала должен быть позже начала.");
        return;
      }
      ctx.session ??= {};
      delete ctx.session.masterSch;
      let closure: Set<string>;
      try {
        closure = new Set(await listClosureDays(supabase));
      } catch {
        closure = new Set();
      }
      if (closure.has(ymd)) {
        await ctx.reply("Этот день сейчас выходной. Сначала сделайте день рабочим (кнопка в карточке дня).");
        return;
      }
      const row = await getMasterAvailabilityForDate(supabase, ymd);
      const start = row?.start_time ?? DEFAULT_MASTER_DAY_START;
      const end = row?.end_time ?? DEFAULT_MASTER_DAY_END;
      const blocked: BlockedInterval[] = [...(row?.blocked_slots ?? [])];
      blocked.push({ start: bs, end: be });
      await upsertMasterAvailability(supabase, {
        date: ymd,
        start_time: start,
        end_time: end,
        is_available: true,
        blocked_slots: blocked,
      });
      await regenerateSlotsForDay(supabase, env, ymd, closure);
      await ctx.reply(
        `🔒 Интервал ${bs}–${be} добавлен в блокировки. Свободные слоты в этом окне сняты (записи сохранены).`
      );
      return;
    }

    return next();
  });

  bot.command("schedule", async (ctx) => {
    if (!isScheduleAdmin(ctx, env)) {
      await ctx.reply(DENY_SCHEDULE);
      return;
    }
    await ctx.reply(await formatWeekTable(supabase, env), {
      parse_mode: "HTML",
      ...weekDayButtons(),
    });
  });

  bot.action("sch:menu", async (ctx) => {
    if (!isScheduleAdmin(ctx, env)) {
      await ctx.answerCbQuery(DENY_SCHEDULE);
      return;
    }
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      "🤲 <b>Меню мастера «Хиджама №1»</b>\n\nВыберите действие:",
      { parse_mode: "HTML", ...masterMainMenuKeyboard() }
    );
  });

  bot.action("sch:week", async (ctx) => {
    if (!isScheduleAdmin(ctx, env)) {
      await ctx.answerCbQuery(DENY_SCHEDULE);
      return;
    }
    await ctx.answerCbQuery();
    await replyPinnedWeekSchedule(ctx, supabase, env);
  });

  bot.action("sch:legacy", async (ctx) => {
    if (!isScheduleAdmin(ctx, env)) {
      await ctx.answerCbQuery(DENY_SCHEDULE);
      return;
    }
    await ctx.answerCbQuery();
    await replyPinnedLegacyHint(ctx);
  });

  bot.action("sch:blockmenu", async (ctx) => {
    if (!isScheduleAdmin(ctx, env)) {
      await ctx.answerCbQuery(DENY_SCHEDULE);
      return;
    }
    await ctx.answerCbQuery();
    await replyPinnedBlockMenu(ctx);
  });

  bot.action("sch:bookings", async (ctx) => {
    if (!isScheduleAdmin(ctx, env)) {
      await ctx.answerCbQuery(DENY_SCHEDULE);
      return;
    }
    await ctx.answerCbQuery();
    await replyPinnedBookings(ctx, supabase);
  });

  bot.action(/^sch:d:(\d{8})$/, async (ctx) => {
    if (!isScheduleAdmin(ctx, env)) {
      await ctx.answerCbQuery(DENY_SCHEDULE);
      return;
    }
    const ymd = unpackYmd(ctx.match[1]);
    if (!ymd) {
      await ctx.answerCbQuery("Неверная дата");
      return;
    }
    const today = irkutskTodayYmd();
    if (ymd < today) {
      await ctx.answerCbQuery("Прошедшие даты не редактируем");
      return;
    }
    await ctx.answerCbQuery();
    let closure: Set<string>;
    try {
      closure = new Set(await listClosureDays(supabase));
    } catch {
      closure = new Set();
    }
    const cfg = await getEffectiveMasterDayConfig(supabase, ymd, closure);
    const row = await getMasterAvailabilityForDate(supabase, ymd);
    const blockedNote =
      row && row.blocked_slots.length > 0
        ? `Блокировки: ${row.blocked_slots.map((b) => `${b.start}–${b.end}`).join(", ")}`
        : "Блокировок нет.";

    await ctx.reply(
      [
        `📅 <b>${formatWeekdayDdMmYyyyFromYmd(ymd)}</b>`,
        cfg.isDayOff
          ? "Статус: выходной (запись недоступна)."
          : `Время работы: ${cfg.startHhmm}–${cfg.endHhmm}`,
        blockedNote,
        "",
        "Что сделать?",
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "Изменить время работы",
              `sch:hours:${ctx.match[1]}`
            ),
          ],
          [
            Markup.button.callback(
              "Заблокировать интервал",
              `sch:blk:${ctx.match[1]}`
            ),
          ],
          [
            Markup.button.callback(
              cfg.isDayOff ? "Сделать рабочим днём" : "Сделать выходным",
              cfg.isDayOff ? `sch:open:${ctx.match[1]}` : `sch:off:${ctx.match[1]}`
            ),
          ],
          [Markup.button.callback("« Назад к неделе", "sch:week")],
        ]),
      }
    );
  });

  bot.action(/^sch:hours:(\d{8})$/, async (ctx) => {
    if (!isScheduleAdmin(ctx, env)) {
      await ctx.answerCbQuery(DENY_SCHEDULE);
      return;
    }
    const ymd = unpackYmd(ctx.match[1]);
    if (!ymd) {
      await ctx.answerCbQuery("Ошибка даты");
      return;
    }
    await ctx.answerCbQuery();
    ctx.session ??= {};
    ctx.session.masterSch = { step: "hours", ymd };
    await ctx.reply(
      [
        "Введите рабочие часы одной строкой:",
        "<code>10:00-21:00</code> (начало и конец через дефис).",
        "После сохранения слоты на этот день пересоберутся; занятые окна не удаляем.",
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  });

  bot.action(/^sch:blk:(\d{8})$/, async (ctx) => {
    if (!isScheduleAdmin(ctx, env)) {
      await ctx.answerCbQuery(DENY_SCHEDULE);
      return;
    }
    const ymd = unpackYmd(ctx.match[1]);
    if (!ymd) {
      await ctx.answerCbQuery("Ошибка даты");
      return;
    }
    await ctx.answerCbQuery();
    ctx.session ??= {};
    ctx.session.masterSch = { step: "block", ymd };
    await ctx.reply(
      "Введите интервал, который нужно <b>закрыть для записи</b>:\n<code>12:00-14:00</code>",
      { parse_mode: "HTML" }
    );
  });

  bot.action(/^sch:off:(\d{8})$/, async (ctx) => {
    if (!isScheduleAdmin(ctx, env)) {
      await ctx.answerCbQuery(DENY_SCHEDULE);
      return;
    }
    const ymd = unpackYmd(ctx.match[1]);
    if (!ymd) {
      await ctx.answerCbQuery("Ошибка даты");
      return;
    }
    await ctx.answerCbQuery();
    let closure: Set<string>;
    try {
      closure = new Set(await listClosureDays(supabase));
    } catch {
      closure = new Set();
    }
    await addClosureDay(supabase, ymd);
    closure.add(ymd);
    await upsertMasterAvailability(supabase, {
      date: ymd,
      start_time: DEFAULT_MASTER_DAY_START,
      end_time: DEFAULT_MASTER_DAY_END,
      is_available: false,
      blocked_slots: [],
    });
    await regenerateSlotsForDay(supabase, env, ymd, closure);
    await ctx.reply(`❌ ${ymd} отмечен как выходной. Свободные слоты убраны; подтверждённые записи остаются.`);
  });

  bot.action(/^sch:open:(\d{8})$/, async (ctx) => {
    if (!isScheduleAdmin(ctx, env)) {
      await ctx.answerCbQuery(DENY_SCHEDULE);
      return;
    }
    const ymd = unpackYmd(ctx.match[1]);
    if (!ymd) {
      await ctx.answerCbQuery("Ошибка даты");
      return;
    }
    await ctx.answerCbQuery();
    let closure: Set<string>;
    try {
      closure = new Set(await listClosureDays(supabase));
    } catch {
      closure = new Set();
    }
    await removeClosureDay(supabase, ymd);
    closure.delete(ymd);
    await upsertMasterAvailability(supabase, {
      date: ymd,
      start_time: DEFAULT_MASTER_DAY_START,
      end_time: DEFAULT_MASTER_DAY_END,
      is_available: true,
      blocked_slots: [],
    });
    await regenerateSlotsForDay(supabase, env, ymd, closure);
    await ctx.reply(`✅ ${ymd} снова рабочий день (${DEFAULT_MASTER_DAY_START}–${DEFAULT_MASTER_DAY_END}). Слоты обновлены.`);
  });
}

function normalizeHhmm(s: string): string {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return s;
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
}

function hhmmToMin(h: string): number {
  const m = h.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}
