import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClientRow } from "../db/types.js";

export async function upsertClient(
  supabase: SupabaseClient,
  input: {
    telegram_user_id: number;
    telegram_username?: string | null;
    full_name?: string | null;
    phone?: string | null;
  }
): Promise<ClientRow> {
  const { data: existing } = await supabase
    .from("clients")
    .select("*")
    .eq("telegram_user_id", input.telegram_user_id)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase
      .from("clients")
      .update({
        telegram_username:
          input.telegram_username !== undefined
            ? input.telegram_username
            : existing.telegram_username,
        full_name:
          input.full_name !== undefined ? input.full_name : existing.full_name,
        phone: input.phone !== undefined ? input.phone : existing.phone,
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return data as ClientRow;
  }

  const { data, error } = await supabase
    .from("clients")
    .insert({
      telegram_user_id: input.telegram_user_id,
      telegram_username: input.telegram_username ?? null,
      full_name: input.full_name ?? null,
      phone: input.phone ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as ClientRow;
}

export async function getClientByTelegramId(
  supabase: SupabaseClient,
  telegramUserId: number
): Promise<ClientRow | null> {
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  if (error) throw error;
  return data as ClientRow | null;
}
