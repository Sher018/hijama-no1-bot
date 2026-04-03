-- Ссылка на оплату ЮKassa (повтор при /start и /mybooking, пока pending_payment)

alter table public.appointments
  add column if not exists yookassa_confirmation_url text;
