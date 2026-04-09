import type { Context } from "telegraf";

export interface SessionData {
  step?: "name" | "phone" | "admin_closure" | "admin_price" | "admin_addslot";
  slotId?: string;
  tempName?: string;
  adminPriceServiceId?: string;
  /** услуга из раздела «Услуги» (для цены в сообщении об оплате) */
  selectedServiceId?: string;
  /** message_id приветствия — не удалять при навигации по кнопкам */
  welcomeMessageId?: number;
  /** Мастер: ввод графика (часы дня / блокировка) */
  masterSch?: {
    step?: "hours" | "block";
    ymd?: string;
  };
}

export type BotContext = Context & { session?: SessionData };
