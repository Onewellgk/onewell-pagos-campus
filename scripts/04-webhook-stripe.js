/**
 * Script 04 — Servidor webhook de Stripe
 *
 * Escucha eventos `checkout.session.completed` y actualiza Airtable.
 *
 * Hace dispatch por `metadata.tipo`:
 *   - "campus_2026" (o sin tipo, retro-compat): flujo automático masivo (n8n).
 *     Usa `metadata.plazo` ('2o' | '3o') → Pagado X / Fecha X.
 *   - "campus_2026_manual": flujo manual de coordinador. Usa `metadata.concepto`:
 *       · reserva_150              → set Pagado tarjeta Jotform = importe
 *       · pago_completo_restante   → += Pagado tarjeta Jotform
 *       · 2o_plazo                 → set Pagado 2º + Fecha 2º
 *       · completar_2o_plazo       → += Pagado 2º + Fecha 2º
 *       · 3r_plazo                 → set Pagado 3º + Fecha 3º
 *       · completar_3r_plazo       → += Pagado 3º + Fecha 3º
 *     Idempotencia por `payment_intent` en Stripe Transaction ID (CSV).
 *
 * Verifica la firma del webhook con STRIPE_WEBHOOK_SECRET.
 * Responde 200 inmediatamente y procesa el evento en background.
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
  const tipo = session.metadata?.tipo;

  if (!recordId) {
    logLine({
      level: 'warn',
      event_id: eventId,
      event_type: event.type,
      msg: 'metadata.airtable_record_id falta; skip',
      metadata: session.metadata,
    });
    return;
  }

  if (tipo === 'campus_2026_manual') {
    return procesarManual(event, session, eventId, recordId);
  }
  // Default: flujo automático ("campus_2026" o sin tipo, retro-compat)
  return procesarAutomatico(event, session, eventId, recordId);
}

async function procesarAutomatico(event, session, eventId, recordId) {
  const plazo = session.metadata?.plazo;
  const amountTotal = session.amount_total;

  if (!plazo) {
    logLine({
      level: 'warn',
      event_id: eventId,
      event_type: event.type,
      airtable_record_id: recordId,
      msg: 'metadata.plazo falta en flujo automático; skip',
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

async function procesarManual(event, session, eventId, recordId) {
  const concepto = session.metadata?.concepto;
  const piId = session.payment_intent;
  const importeEur = (session.amount_total || 0) / 100;
  const fecha = dateStampMadrid();

  if (!concepto) {
    logLine({
      level: 'warn',
      event_id: eventId,
      event_type: event.type,
      airtable_record_id: recordId,
      msg: 'metadata.concepto falta en flujo manual; skip',
      metadata: session.metadata,
    });
    return;
  }

  // Idempotencia por payment_intent: si ya está registrado en STRIPE_TX_ID, skip.
  // Permite varios PIs por record (ej. reserva_150 + pago_completo_restante) en CSV.
  const current = await getCampusRecord(recordId);
  const existingTxId = String(current.fields?.[CAMPUS_FIELDS.stripeTransactionId] || '');
  if (piId && existingTxId.split(',').map((s) => s.trim()).includes(piId)) {
    logLine({
      level: 'info',
      event_id: eventId,
      event_type: event.type,
      airtable_record_id: recordId,
      tipo: 'campus_2026_manual',
      concepto,
      pi_id: piId,
      msg: 'pi_id ya registrado en stripeTransactionId; evento duplicado, skip',
    });
    return;
  }
  const newTxId = existingTxId ? `${existingTxId},${piId}` : piId;

  let updates = null;

  switch (concepto) {
    case 'reserva_150': {
      updates = {
        [CAMPUS_FIELDS.pagadoTarjetaJotform]: importeEur,
        [CAMPUS_FIELDS.stripeTransactionId]: newTxId,
      };
      break;
    }
    case 'pago_completo_restante': {
      const prev = Number(current.fields?.[CAMPUS_FIELDS.pagadoTarjetaJotform] || 0);
      updates = {
        [CAMPUS_FIELDS.pagadoTarjetaJotform]: +(prev + importeEur).toFixed(2),
        [CAMPUS_FIELDS.stripeTransactionId]: newTxId,
      };
      break;
    }
    case '2o_plazo': {
      updates = {
        [CAMPUS_FIELDS.pagado2oPago]: importeEur,
        [CAMPUS_FIELDS.fechaPago2oPlazo]: fecha,
        [CAMPUS_FIELDS.stripeTransactionId]: newTxId,
      };
      break;
    }
    case 'completar_2o_plazo': {
      const prev = Number(current.fields?.[CAMPUS_FIELDS.pagado2oPago] || 0);
      updates = {
        [CAMPUS_FIELDS.pagado2oPago]: +(prev + importeEur).toFixed(2),
        [CAMPUS_FIELDS.fechaPago2oPlazo]: fecha,
        [CAMPUS_FIELDS.stripeTransactionId]: newTxId,
      };
      break;
    }
    case '3r_plazo': {
      updates = {
        [CAMPUS_FIELDS.pagado3rPago]: importeEur,
        [CAMPUS_FIELDS.fechaPago3rPlazo]: fecha,
        [CAMPUS_FIELDS.stripeTransactionId]: newTxId,
      };
      break;
    }
    case 'completar_3r_plazo': {
      const prev = Number(current.fields?.[CAMPUS_FIELDS.pagado3rPago] || 0);
      updates = {
        [CAMPUS_FIELDS.pagado3rPago]: +(prev + importeEur).toFixed(2),
        [CAMPUS_FIELDS.fechaPago3rPlazo]: fecha,
        [CAMPUS_FIELDS.stripeTransactionId]: newTxId,
      };
      break;
    }
    default:
      logLine({
        level: 'warn',
        event_id: eventId,
        event_type: event.type,
        airtable_record_id: recordId,
        tipo: 'campus_2026_manual',
        concepto,
        importe_eur: importeEur,
        pi_id: piId,
        msg: `concepto manual desconocido; revisión manual requerida (no se actualiza Airtable)`,
      });
      return;
  }

  await updateCampusRecord(recordId, updates);

  logLine({
    level: 'info',
    event_id: eventId,
    event_type: event.type,
    airtable_record_id: recordId,
    tipo: 'campus_2026_manual',
    concepto,
    importe_eur: importeEur,
    pi_id: piId,
    fecha_pago: fecha,
    msg: 'Airtable actualizado (manual)',
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
