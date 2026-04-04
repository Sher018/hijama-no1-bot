const TZ = "Asia/Irkutsk";

export function formatSlotRu(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatShortRu(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Дата календаря в Иркутске для слота (UTC → Asia/Irkutsk), формат YYYY-MM-DD */
export function formatIrkutskDateOnly(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}
