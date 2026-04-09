-- График мастера: окна приёма по дням, блокировки, выходные (Иркутск).
-- blocked_slots: [{"start":"12:00","end":"14:00"}, ...] — интервалы в локальном времени дня.

create table if not exists public.master_availability (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  start_time time not null default time '10:00',
  end_time time not null default time '21:00',
  is_available boolean not null default true,
  blocked_slots jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint master_availability_end_after_start check (end_time > start_time)
);

comment on table public.master_availability is
  'Параметры дня для генерации слотов (60 мин). Нет строки — дефолт 10:00–21:00 в коде.';

drop trigger if exists master_availability_updated_at on public.master_availability;

create trigger master_availability_updated_at
  before update on public.master_availability
  for each row execute function public.set_updated_at();

alter table public.master_availability enable row level security;
