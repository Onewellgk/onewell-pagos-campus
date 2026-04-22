import Stripe from 'stripe';
import { config } from './config.js';

const stripe = new Stripe(config.stripe.secretKey);

/**
 * Devuelve el customer Stripe. Si se pasa `existingCustomerId` no vacío,
 * lo recupera (verifica que existe); si no, crea uno nuevo con los datos
 * del tutor.
 */
export async function getOrCreateCustomer({
  existingCustomerId,
  email,
  name,
  phone,
  metadata = {},
}) {
  if (existingCustomerId) {
    const c = await stripe.customers.retrieve(existingCustomerId);
    if (c && !c.deleted) return c;
    // Si el customer fue borrado en Stripe, caemos a crear uno nuevo.
  }

  const params = { email, name, metadata };
  if (phone) params.phone = String(phone);

  return stripe.customers.create(params);
}

/**
 * Crea un Product y un Price en EUR asociado. `amountEur` en euros (ej 322.50).
 * Devuelve { productId, priceId }.
 */
export async function createProductWithPrice({ name, amountEur, metadata = {} }) {
  const product = await stripe.products.create({ name, metadata });

  const unitAmount = Math.round(amountEur * 100); // céntimos
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: unitAmount,
    currency: 'eur',
  });

  return { productId: product.id, priceId: price.id };
}

/**
 * Crea un Payment Link para un price. Metadata se copia también a la
 * checkout session (el webhook la lee desde la session).
 */
export async function createPaymentLink({ priceId, metadata = {} }) {
  const link = await stripe.paymentLinks.create({
    line_items: [{ price: priceId, quantity: 1 }],
    metadata,
    // La metadata también se propaga a la checkout.session creada al pagar,
    // así el webhook puede leer airtable_record_id y plazo.
    payment_intent_data: { metadata },
    customer_creation: 'if_required',
    after_completion: { type: 'hosted_confirmation' },
  });

  return { id: link.id, url: link.url };
}

/**
 * Verifica la firma de un evento de webhook. Devuelve el evento parseado
 * o lanza si la firma es inválida.
 */
export function constructWebhookEvent(rawBody, signatureHeader, secret) {
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

export { stripe };
