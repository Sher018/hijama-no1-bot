import { z } from "zod";
import "dotenv/config";

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
    (v) => (v === "" || v === undefined ? undefined : v),
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
