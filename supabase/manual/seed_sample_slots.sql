-- =============================================================================
-- Ручной тестовый сид (не обязателен): в проде слоты создаёт бот — каждые ~2 мин
-- планировщик дополняет горизонт (см. AUTO_SLOTS_* в .env.example, 5 окон в день).
-- =============================================================================
-- Примеры двух слотов вручную (Asia/Irkutsk). Повторный запуск добавит строки.

WITH params AS (
  SELECT (now() AT TIME ZONE 'Asia/Irkutsk')::date AS irk_today
)
INSERT INTO public.slots (starts_at, ends_at, is_published, is_booked)
SELECT
  ((irk_today + 2) + interval '14 hours') AT TIME ZONE 'Asia/Irkutsk',
  ((irk_today + 2) + interval '15 hours') AT TIME ZONE 'Asia/Irkutsk',
  true,
  false
FROM params
UNION ALL
SELECT
  ((irk_today + 3) + interval '10 hours') AT TIME ZONE 'Asia/Irkutsk',
  ((irk_today + 3) + interval '11 hours') AT TIME ZONE 'Asia/Irkutsk',
  true,
  false
FROM params;
