const TZ = "Asia/Irkutsk";

export function parseHHMM(s: string): { h: number; m: number } | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

/** Час и минута начала слота в календаре Иркутска */
export function getIrkutskHourMinute(iso: string): { h: number; m: number } {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return { h: hour, m: minute };
}

export function minutesFromMidnightIrkutsk(iso: string): number {
  const { h, m } = getIrkutskHourMinute(iso);
  return h * 60 + m;
}

/**
 * Начало сеанса попадает в график (по локальному времени Иркутска).
 * @param endHHMM конец окна включительно (например 21:00 — последний допустимый старт в 21:00).
 */
export function isWithinWorkingHours(
  startsAtIso: string,
  startHHMM: string,
  endHHMM: string
): boolean {
  const slotMin = minutesFromMidnightIrkutsk(startsAtIso);
  const a = parseHHMM(startHHMM);
  const b = parseHHMM(endHHMM);
  if (!a || !b) return true;
  const startMin = a.h * 60 + a.m;
  const endMin = b.h * 60 + b.m;
  if (startMin > endMin) return true;
  return slotMin >= startMin && slotMin <= endMin;
}
