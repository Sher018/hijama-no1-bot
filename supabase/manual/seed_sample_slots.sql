-- Примеры слотов для теста (Иркутск UTC+8). Подставьте свои даты в будущем.
-- Выполните в SQL Editor после миграций.

insert into public.slots (starts_at, ends_at, is_published, is_booked)
values
  ((now() at time zone 'utc' + interval '2 days')::timestamptz,
   (now() at time zone 'utc' + interval '2 days' + interval '60 minutes')::timestamptz,
   true, false),
  ((now() at time zone 'utc' + interval '3 days')::timestamptz,
   (now() at time zone 'utc' + interval '3 days' + interval '60 minutes')::timestamptz,
   true, false);
