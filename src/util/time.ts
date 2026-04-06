const TZ = "Asia/Irkutsk";

function formatTimeHm(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** Дата в Иркутске: ДД-ММ-ГГГГ */
export function formatDdMmYyyy(iso: string): string {
  const d = new Date(iso);
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
  return s.replace(/\//g, "-");
}

/** Дата и время: ДД-ММ-ГГГГ, ЧЧ:ММ */
export function formatShortRu(iso: string): string {
  return `${formatDdMmYyyy(iso)}, ${formatTimeHm(iso)}`;
}

/** День недели, дата ДД-ММ-ГГГГ, время ЧЧ:ММ */
export function formatSlotRu(iso: string): string {
  const weekday = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ,
    weekday: "long",
  }).format(new Date(iso));
  return `${weekday}, ${formatDdMmYyyy(iso)}, ${formatTimeHm(iso)}`;
}

/** Дата календаря в Иркутске для слота (UTC → Asia/Irkutsk), формат YYYY-MM-DD — для БД и сравнений */
export function formatIrkutskDateOnly(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** YYYY-MM-DD → ДД-ММ-ГГГГ (для показа пользователю) */
export function isoYmdToDdMmYyyy(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** ДД-ММ-ГГГГ → YYYY-MM-DD для БД */
export function ddMmYyyyToIsoYmd(s: string): string | null {
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Начало текущего календарного месяца в Иркутске (00:00) в ISO UTC.
 * Слоты с `starts_at` строго раньше — прошлые периоды (очистка в боте).
 */
export function irkutskCurrentMonthStartUtcIso(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Irkutsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  if (!y || !m) {
    throw new Error("irkutskCurrentMonthStartUtcIso: нет даты");
  }
  return new Date(`${y}-${m}-01T00:00:00+08:00`).toISOString();
}

/** Границы суток по календарю Иркутска (YYYY-MM-DD) в ISO для запросов к БД. */
export function irkutskDayUtcRange(dayYyyyMmDd: string): {
  fromInclusive: string;
  toExclusive: string;
} {
  const from = new Date(`${dayYyyyMmDd}T00:00:00+08:00`);
  const toExclusive = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return {
    fromInclusive: from.toISOString(),
    toExclusive: toExclusive.toISOString(),
  };
}
