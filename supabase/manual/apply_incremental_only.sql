-- =============================================================================
-- ДОНАСТРОЙКА существующей базы (таблица slots УЖЕ есть)
--
-- Если при запуске schema_full_apply_in_order.sql вы видите:
--   ERROR: relation "slots" already exists
-- значит начальная схема уже применена. НЕ запускайте полный файл снова.
-- Выполните ТОЛЬКО этот скрипт один раз в Supabase → SQL Editor → Run.
--
-- Содержит миграции:
--   20260405140000_add_yookassa_confirmation_url.sql
--   20260406120000_closure_days.sql (idempotent: IF NOT EXISTS)
--   20260407120000_slots_starts_at_unique.sql
--   20260408120000_reminder_skip_one_hour.sql
-- =============================================================================

-- Ссылка на оплату ЮKassa (повтор при /start и /mybooking, пока pending_payment)
alter table public.appointments
  add column if not exists yookassa_confirmation_url text;

-- Дни без записи (календарь Иркутска)
create table if not exists public.closure_days (
  day date primary key,
  created_at timestamptz not null default now()
);

alter table public.closure_days enable row level security;

-- Уникальное время начала слота (автослоты + ручной ввод)
drop index if exists public.slots_starts_at_idx;

create unique index slots_starts_at_idx on public.slots (starts_at);

comment on table public.slots is
  'Слоты приёма; календарь и часы в приложении — Иркутск. Пять стандартных окон в день создаёт бот (AUTO_SLOTS_*).';

alter table public.appointments
  add column if not exists reminder_skip_one_hour boolean not null default false;
