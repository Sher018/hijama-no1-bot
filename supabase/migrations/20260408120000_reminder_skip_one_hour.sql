-- Если клиент подтвердил визит в напоминании за 2 ч — не слать напоминание за 1 ч.
alter table public.appointments
  add column if not exists reminder_skip_one_hour boolean not null default false;

comment on column public.appointments.reminder_skip_one_hour is
  'Клиент нажал «подтверждаю» в уведомлении за 2 ч — пропустить уведомление за 1 ч.';
