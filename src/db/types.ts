export type AppointmentStatus =
  | "pending_payment"
  | "confirmed"
  | "cancelled"
  | "completed";

export interface SlotRow {
  id: string;
  starts_at: string;
  ends_at: string;
  is_published: boolean;
  is_booked: boolean;
  created_at: string;
}

export interface ClientRow {
  id: string;
  telegram_user_id: number;
  telegram_username: string | null;
  full_name: string | null;
  phone: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppointmentRow {
  id: string;
  slot_id: string;
  client_id: string;
  status: AppointmentStatus;
  session_price_min_rub: number;
  session_price_max_rub: number;
  prepayment_rub: number;
  yookassa_payment_id: string | null;
  yookassa_confirmation_url: string | null;
  idempotency_key: string | null;
  notes: string | null;
  reminder_2h_sent_at: string | null;
  reminder_1h_sent_at: string | null;
  /** Клиент подтвердил визит в напоминании за 2 ч — не слать напоминание за 1 ч */
  reminder_skip_one_hour?: boolean;
  created_at: string;
  updated_at: string;
}

export interface AppointmentWithRelations extends AppointmentRow {
  slots: SlotRow;
  clients: ClientRow;
}
