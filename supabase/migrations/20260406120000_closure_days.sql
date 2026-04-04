-- Дни, когда запись на приём не ведётся (дата в календаре Иркутска относительно слота).
create table public.closure_days (
  day date primary key,
  created_at timestamptz not null default now()
);

alter table public.closure_days enable row level security;
