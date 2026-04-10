/** Канонический вид для клиента: 8-9XX-XXX-XX-XX (ровно 11 цифр с ведущей 8). */
const CANON =
  /^8-(\d{3})-(\d{3})-(\d{2})-(\d{2})$/;

/**
 * Принимает номер в формате с дефисами или только цифры (+7 / 7 / 8 / 9…).
 * Возвращает строку вида 8-XXX-XXX-XX-XX или null.
 */
export function normalizeClientPhoneRu(raw: string): string | null {
  const trimmed = raw.trim();
  const m = trimmed.match(CANON);
  if (m) {
    const inner = `${m[1]}${m[2]}${m[3]}${m[4]}`;
    if (!/^\d{10}$/.test(inner)) return null;
    return `8-${m[1]}-${m[2]}-${m[3]}-${m[4]}`;
  }

  const d = trimmed.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("8")) {
    const rest = d.slice(1);
    if (!/^\d{10}$/.test(rest)) return null;
    return `8-${rest.slice(0, 3)}-${rest.slice(3, 6)}-${rest.slice(6, 8)}-${rest.slice(8, 10)}`;
  }
  if (d.length === 11 && d.startsWith("7")) {
    const rest = d.slice(1);
    if (!/^\d{10}$/.test(rest)) return null;
    return `8-${rest.slice(0, 3)}-${rest.slice(3, 6)}-${rest.slice(6, 8)}-${rest.slice(8, 10)}`;
  }
  if (d.length === 10 && d.startsWith("9")) {
    return `8-${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8, 10)}`;
  }
  return null;
}

export const CLIENT_PHONE_FORMAT_HINT =
  "Введите номер в формате <b>8-912-345-67-89</b> (8, затем три-три-две-две цифры через дефис). Можно без дефисов: 89123456789 или +79123456789.";
