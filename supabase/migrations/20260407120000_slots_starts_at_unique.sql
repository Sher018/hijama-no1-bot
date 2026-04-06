-- Один слот на момент начала (автослоты + /addslot без дублей по времени).
-- Если ошибка duplicate key: удалите лишние строки с одинаковым starts_at вручную.

drop index if exists public.slots_starts_at_idx;

create unique index slots_starts_at_idx on public.slots (starts_at);

comment on table public.slots is
  'Слоты приёма; календарь и часы в приложении — Иркутск. Пять стандартных окон в день создаёт бот (AUTO_SLOTS_*).';
