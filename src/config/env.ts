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
