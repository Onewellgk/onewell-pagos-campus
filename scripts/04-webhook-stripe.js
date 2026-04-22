/**
 * Script 04 — Servidor webhook de Stripe
 *
 * Escucha eventos `checkout.session.completed` y actualiza Airtable:
 *   - plazo "2o": Pagado 2o pago, Fecha pago 2o plazo
 *   - plazo "3o": Pagado 3r pago, Fecha pago 3r plazo
 *
 * Verifica la firma del webhook con STRIPE_WEBHOOK_SECRET.
 * Responde 200 inmediatamente y procesa el evento en background.
 * Idempotente: si el campo "Pagado Xº pago" ya está poblado, no reescribe.
 */

import express from 'express';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMPUS_FIELDS, config } from '../src/config.js';
import { getCampusRecord, updateCampusRecord } from '../src/airtable.js';
import { constructWebhookEvent } from '../src/stripe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', 'logs');

if (!config.stripe.webhookSecret) {
  console.error(
    '✗ STRIPE_WEBHOOK_SECRET no está en .env.\n' +
    '  Lanza `stripe listen --forward-to localhost:' +
    config.webhook.port +
    '/webhook-stripe` y copia el whsec_... que imprime.'
  );
  process.exit(1);
}

mkdirSync(LOGS_DIR, { recursive: true });

function dateStampMadrid() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function fileTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function logLine(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  const file = join(LOGS_DIR, `webhook-${fileTimestamp()}.log`);
  try {
    appendFileSync(file, line + '\n', 'utf8');
  } catch (err) {
    console.error('✗ No se pudo escribir en log file:', err.message);
  }
  console.log(line);
}

async function procesarCheckoutCompleted(event) {
  const session = event.data.object;
  const eventId = event.id;

  const recordId = session.metadata?.airtable_record_id;
  const plazo = session.metadata?.plazo;
  const amountTotal = session.amount_total;

  if (!recordId || !plazo) {
    logLine({
      level: 'warn',
      event_id: eventId,
      event_type: event.type,
      msg: 'metadata.airtable_record_id o metadata.plazo faltan; skip',
      metadata: session.metadata,
    });
    return;
  }
  if (plazo !== '2o' && plazo !== '3o') {
    logLine({
      level: 'warn',
      event_id: eventId,
      event_type: event.type,
      airtable_record_id: recordId,
      msg: `metadata.plazo desconocido: ${plazo}`,
    });
    return;
  }

  const importeEur = (amountTotal || 0) / 100;

  const campoPagado = plazo === '2o' ? CAMPUS_FIELDS.pagado2oPago : CAMPUS_FIELDS.pagado3rPago;
  const campoFecha = plazo === '2o' ? CAMPUS_FIELDS.fechaPago2oPlazo : CAMPUS_FIELDS.fechaPago3rPlazo;

  const current = await getCampusRecord(recordId);
  const yaPagado = current.fields?.[campoPagado];
  const yaFecha = current.fields?.[campoFecha];
  const tienePagado = yaPagado !== undefined && yaPagado !== null && yaPagado !== '';
  const tieneFecha = yaFecha !== undefined && yaFecha !== null && yaFecha !== '';

  const fecha = dateStampMadrid();

  // Idempotencia con matiz:
  //   - Ambos campos ya con valor      → evento duplicado, skip.
  //   - Pagado sí, Fecha no            → solo rellenar fecha (no tocar importe).
  //   - Pagado no (caso normal)        → escribir importe + fecha.
  if (tienePagado && tieneFecha) {
    logLine({
      level: 'info',
      event_id: eventId,
      event_type: event.type,
      airtable_record_id: recordId,
      plazo,
      msg: 'ya pagado y fechado previamente; evento duplicado, skip',
      importe_en_airtable: yaPagado,
      fecha_en_airtable: yaFecha,
      importe_evento: importeEur,
    });
    return;
  }

  if (tienePagado && !tieneFecha) {
    await updateCampusRecord(recordId, { [campoFecha]: fecha });
    logLine({
      level: 'info',
      event_id: eventId,
      event_type: event.type,
      airtable_record_id: recordId,
      plazo,
      fecha_pago: fecha,
      msg: 'Pagado ya estaba, solo relleno Fecha',
      importe_en_airtable: yaPagado,
      importe_evento: importeEur,
    });
    return;
  }

  await updateCampusRecord(recordId, {
    [campoPagado]: importeEur,
    [campoFecha]: fecha,
  });

  logLine({
    level: 'info',
    event_id: eventId,
    event_type: event.type,
    airtable_record_id: recordId,
    plazo,
    importe_eur: importeEur,
    fecha_pago: fecha,
    msg: 'Airtable actualizado',
  });
}

const app = express();

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post(
  '/webhook-stripe',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const signature = req.headers['stripe-signature'];
    let event;
    try {
      event = constructWebhookEvent(req.body, signature, config.stripe.webhookSecret);
    } catch (err) {
      logLine({ level: 'error', msg: 'firma inválida', error: err.message });
      return res.status(400).send(`Webhook signature error: ${err.message}`);
    }

    // Responder 200 primero; procesar después para no timeoutear Stripe.
    res.status(200).json({ received: true });

    setImmediate(() => {
      (async () => {
        try {
          if (event.type === 'checkout.session.completed') {
            await procesarCheckoutCompleted(event);
          } else {
            logLine({
              level: 'debug',
              event_id: event.id,
              event_type: event.type,
              msg: 'evento ignorado (no manejado)',
            });
          }
        } catch (err) {
          logLine({
            level: 'error',
            event_id: event.id,
            event_type: event.type,
            msg: 'error procesando evento',
            error: err.message,
            stack: err.stack,
          });
        }
      })();
    });
  }
);

const port = config.webhook.port;
app.listen(port, () => {
  console.log('='.repeat(70));
  console.log(`Stripe webhook escuchando en http://localhost:${port}`);
  console.log(`  POST /webhook-stripe`);
  console.log(`  GET  /health`);
  console.log('='.repeat(70));
  console.log(
    '\nRecuerda tener `stripe listen --forward-to localhost:' +
      port +
      '/webhook-stripe` corriendo en otra terminal.'
  );
});
