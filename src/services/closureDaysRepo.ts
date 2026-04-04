import type { SupabaseClient } from "@supabase/supabase-js";

export async function listClosureDays(
  supabase: SupabaseClient
): Promise<string[]> {
  const { data, error } = await supabase
    .from("closure_days")
    .select("day")
    .order("day", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((r: { day: string }) => r.day);
}

export async function addClosureDay(
  supabase: SupabaseClient,
  day: string
): Promise<void> {
  const { error } = await supabase
    .from("closure_days")
    .upsert({ day }, { onConflict: "day" });
  if (error) throw error;
}

export async function removeClosureDay(
  supabase: SupabaseClient,
  day: string
): Promise<void> {
  const { error } = await supabase.from("closure_days").delete().eq("day", day);
  if (error) throw error;
}
