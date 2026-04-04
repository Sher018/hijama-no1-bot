-- Примеры слотов: начало в 14:00 и 10:00 по Иркутску (в графике 09:00–21:00).
-- Раньше использовался now()+N days без времени — получались ночные слоты.

insert into public.slots (starts_at, ends_at, is_published, is_booked)
values
  (
    ((now() at time zone 'Asia/Irkutsk')::date + interval '2 days' + interval '14 hours')
      at time zone 'Asia/Irkutsk',
    ((now() at time zone 'Asia/Irkutsk')::date + interval '2 days' + interval '15 hours')
      at time zone 'Asia/Irkutsk',
    true,
    false
  ),
  (
    ((now() at time zone 'Asia/Irkutsk')::date + interval '3 days' + interval '10 hours')
      at time zone 'Asia/Irkutsk',
    ((now() at time zone 'Asia/Irkutsk')::date + interval '3 days' + interval '11 hours')
      at time zone 'Asia/Irkutsk',
    true,
    false
  );
