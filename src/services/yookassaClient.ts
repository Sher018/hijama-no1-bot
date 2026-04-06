import type { Env } from "../config/env.js";

const API = "https://api.yookassa.ru/v3/payments";

/** Статус платежа в API ЮKassa: pending, waiting_for_capture, succeeded, canceled. */
export async function getYookassaPayment(
  env: Env,
  paymentId: string
): Promise<{ id: string; status: string } | null> {
  const basic = Buffer.from(
    `${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`
  ).toString("base64");
  const res = await fetch(`${API}/${paymentId}`, {
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!res.ok) {
    console.warn(
      `ЮKassa GET payment ${paymentId}: ${res.status} ${await res.text()}`
    );
    return null;
  }
  const body = (await res.json()) as { id?: string; status?: string };
  if (!body.id || !body.status) return null;
  return { id: body.id, status: body.status };
}

export interface CreatePaymentResult {
  id: string;
  confirmationUrl: string;
}

export async function createYookassaPayment(
  env: Env,
  input: {
    amountRub: number;
    returnUrl: string;
    description: string;
    idempotenceKey: string;
    metadata: Record<string, string>;
  }
): Promise<CreatePaymentResult> {
  const basic = Buffer.from(
    `${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`
  ).toString("base64");

  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Idempotence-Key": input.idempotenceKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: {
        value: input.amountRub.toFixed(2),
        currency: "RUB",
      },
      capture: true,
      confirmation: {
        type: "redirect",
        return_url: input.returnUrl,
      },
      description: input.description,
      metadata: input.metadata,
    }),
  });

  const body = (await res.json()) as Record<string, unknown>;

  if (!res.ok) {
    throw new Error(
      `ЮKassa create payment failed: ${res.status} ${JSON.stringify(body)}`
    );
  }

  const id = body.id as string;
  const confirmation = body.confirmation as
    | { confirmation_url?: string }
    | undefined;
  const url = confirmation?.confirmation_url;
  if (!id || !url) {
    throw new Error(`ЮKassa: нет id или confirmation_url: ${JSON.stringify(body)}`);
  }

  return { id, confirmationUrl: url };
}
