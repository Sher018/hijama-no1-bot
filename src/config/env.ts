import { z } from "zod";
import "dotenv/config";

/** Убирает пробелы/кавычки из UI; при отсутствии схемы добавляет https:// */
function normalizePublicBaseUrl(v: unknown): string | undefined {
  if (v === "" || v === undefined) return undefined;
  let s = String(v).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  if (!s) return undefined;
  if (!/^https?:\/\//i.test(s)) {
    s = `https://${s}`;
  }
  return s.replace(/\/+$/, "");
}

function normalizeHHMM(v: unknown, fallback: string): string {
  const raw = v === undefined || v === "" ? fallback : String(v).trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallback;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

const schema = z.object({
  BOT_TOKEN: z.string().min(1),
  BOT_USERNAME: z.string().min(1),
  ADMIN_TELEGRAM_ID: z
    .string()
    .min(1, "Укажите ADMIN_TELEGRAM_ID (числовой id в Telegram)")
    .transform((s) => Number(s.trim()))
    .refine(
      (n) => Number.isInteger(n) && n > 0,
      "ADMIN_TELEGRAM_ID должен быть целым числом > 0"
    ),

  PUBLIC_BASE_URL: z.preprocess(
    (v) => normalizePublicBaseUrl(v),
    z.string().url().optional()
  ),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  YOOKASSA_SHOP_ID: z.string().min(1),
  YOOKASSA_SECRET_KEY: z.string().min(1),
  YOOKASSA_WEBHOOK_USER: z.string().min(1),
  YOOKASSA_WEBHOOK_PASSWORD: z.string().min(1),

  TELEGRAM_USE_POLLING: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  PORT: z.coerce.number().int().positive().default(3000),

  /** Начало рабочего дня (Иркутск), показ слотов и /addslot */
  WORKING_HOURS_START: z.preprocess(
    (v) => normalizeHHMM(v, "09:00"),
    z.string()
  ),
  /** Конец окна записи включительно (Иркутск), напр. 21:00 — можно старт в 21:00 */
  WORKING_HOURS_END: z.preprocess(
    (v) => normalizeHHMM(v, "21:00"),
    z.string()
  ),

  /** Максимум слотов на один календарный день (Иркутск), в пределах графика WORKING_HOURS_* */
  MAX_SLOTS_PER_DAY: z.coerce.number().int().positive().default(5),

  /** Автослоты: 5 окон в день (10,13,15,17,19 Иркутск). false — только ручное /addslot */
  AUTO_SLOTS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== "false" && v !== "0"),

  /** На сколько дней вперёд поддерживать автослоты (включая сегодня) */
  AUTO_SLOTS_HORIZON_DAYS: z.coerce.number().int().positive().max(90).default(14),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Неверные переменные окружения: ${JSON.stringify(msg)}`);
  }
  return parsed.data;
}
