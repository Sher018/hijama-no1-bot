/** JSON в appointments.notes: выбранная услуга при записи. */
export function parseAppointmentServiceId(
  notes: string | null
): string | undefined {
  if (!notes?.trim()) return undefined;
  try {
    const o = JSON.parse(notes) as { service_id?: unknown };
    if (typeof o.service_id === "string" && o.service_id.length > 0) {
      return o.service_id;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
