/**
 * Script 04 — Servidor webhook de Stripe + endpoint /post-jotform
 *
 * Escucha eventos `checkout.session.completed` y actualiza Airtable.
 *
 * Hace dispatch por `metadata.tipo`:
 *   - "campus_setup_intent": flujo nuevo Phase 2 (cobro automático con tarjeta del
 *     primer plazo, con setup_future_usage='off_session' para guardar la tarjeta
 *     y poder cobrar 2º/3r plazo automáticamente). Resuelve el record Airtable
 *     buscando por `metadata.jotform_submission_id` (no por airtable_record_id).
 *     Procesado SÍNCRONAMENTE para poder devolver 503 cuando la integración
 *     nativa Jotform→Airtable aún no ha creado el record (race) → Stripe reintenta.
 *
 *   - "campus_2026" (o sin tipo, retro-compat): flujo automático masivo (n8n).
 *     Usa `metadata.plazo` ('2o' | '3o') → Pagado X / Fecha X.
 *
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
 * Para los flujos automatico/manual responde 200 inmediatamente y procesa el
 * evento en background. Para campus_setup_intent procesa síncrono (200 / 503).
 *
 * Además, monta las rutas del flujo Phase 2 en este mismo servidor:
 *   GET /post-jotform              — receptor del Jotform, crea Checkout Session
 *   GET /post-jotform/success      — landing post-pago OK
 *   GET /post-jotform/cancel       — landing pago cancelado
 *   GET /gracias-efectivo          — landing flujo efectivo
 *   GET /gracias-revision          — landing flujo indeterminado
 */

import express from 'express';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMPUS_FIELDS, config } from '../src/config.js';
import {
  getCampusRecord,
  updateCampusRecord,
  findCampusBySubmissionId,
} from '../src/airtable.js';
import { constructWebhookEvent, stripe } from '../src/stripe.js';
import { mountPostJotformRoutes } from '../src/post-jotform.js';

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

if (!config.publicBaseUrl) {
  console.warn(
    '⚠ PUBLIC_BASE_URL no configurada. /post-jotform devolverá 500 cuando se use.\n' +
    '  Setea esta env en EasyPanel a la URL pública del servicio (ej. https://webhook.academy.onewellgk.com).'
  );
}

if (config.enableTestMode) {
  console.warn(
    '⚠ ENABLE_TEST_MODE=true — el endpoint /post-jotform aceptará ?test=1 con submission sintética.\n' +
    '  Esto debe estar deshabilitado en producción una vez validado el smoke test.'
  );
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
  const tipo = session.metadata?.tipo;

  // El flujo nuevo de Phase 2 (campus_setup_intent) busca el record por
  // jotform_submission_id, no por airtable_record_id. Despachamos antes del
  // check de recordId para no abortar prematuramente.
  if (tipo === 'campus_setup_intent') {
    return procesarCampusSetupIntent(event, session, eventId);
  }

  const recordId = session.metadata?.airtable_record_id;
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

/**
 * Handler del flujo Phase 2 (cobro automático con tarjeta + setup_future_usage).
 *
 * Especialidades vs. los otros handlers:
 *   - Resuelve el record Airtable buscando por `metadata.jotform_submission_id`.
 *     Si no lo encuentra (race con la integración nativa Jotform→Airtable),
 *     devuelve la cadena 'NOT_FOUND'. El caller HTTP traduce eso a 503 → Stripe
 *     reintentará el evento con backoff exponencial.
 *   - Expande la Checkout Session para extraer customer + payment_intent + payment_method
 *     y poder escribir Stripe Customer ID y PaymentMethod ID en Airtable.
 *   - Solo escribe el PaymentMethod ID si setup_future_usage estaba activo
 *     (caso contrario el pm_id existe pero no es reutilizable y no aporta valor).
 *
 * Convención de retorno: undefined si todo OK o si se hizo skip por idempotencia,
 * 'NOT_FOUND' si el record no existe todavía.
 */
async function procesarCampusSetupIntent(event, session, eventId) {
  const submissionId = session.metadata?.jotform_submission_id;
  const setupFutureUsageEnabled = session.metadata?.setup_future_usage_enabled === 'true';
  const piId = session.payment_intent;

  if (!submissionId) {
    logLine({
      level: 'warn',
      event_id: eventId,
      event_type: event.type,
      msg: 'metadata.jotform_submission_id falta en campus_setup_intent; skip',
      metadata: session.metadata,
    });
    return;
  }

  // Buscar el record en Airtable. Si no se encuentra, race con la integración
  // nativa Jotform→Airtable: devuelve NOT_FOUND para que el caller responda 503.
  const record = await findCampusBySubmissionId(submissionId);
  if (!record) {
    logLine({
      level: 'warn',
      event_id: eventId,
      event_type: event.type,
      tipo: 'campus_setup_intent',
      jotform_submission_id: submissionId,
      pi_id: piId,
      msg: 'Airtable record no encontrado para sid; race con Jotform→Airtable, devuelvo NOT_FOUND',
    });
    return 'NOT_FOUND';
  }

  const recordId = record.id;
  const importeEur = (session.amount_total || 0) / 100;
  const fecha = dateStampMadrid();

  // Idempotencia: si el pi_id ya está registrado en Stripe Transaction ID, skip.
  const current = await getCampusRecord(recordId);
  const existingTxId = String(current.fields?.[CAMPUS_FIELDS.stripeTransactionId] || '');
  if (piId && existingTxId.split(',').map((s) => s.trim()).includes(piId)) {
    logLine({
      level: 'info',
      event_id: eventId,
      event_type: event.type,
      airtable_record_id: recordId,
      tipo: 'campus_setup_intent',
      jotform_submission_id: submissionId,
      pi_id: piId,
      msg: 'pi_id ya registrado en stripeTransactionId; evento duplicado, skip',
    });
    return;
  }
  const newTxId = existingTxId ? `${existingTxId},${piId}` : piId;

  // Expandir la session para obtener customer y payment_method en una sola llamada.
  let expanded;
  try {
    expanded = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['payment_intent', 'payment_intent.payment_method', 'customer'],
    });
  } catch (err) {
    logLine({
      level: 'error',
      event_id: eventId,
      event_type: event.type,
      airtable_record_id: recordId,
      tipo: 'campus_setup_intent',
      jotform_submission_id: submissionId,
      pi_id: piId,
      msg: 'error expandiendo Checkout Session — no se actualiza Airtable',
      error: err.message,
    });
    // No marcamos como NOT_FOUND: el record existe pero no podemos leer Stripe.
    // Lanzamos para que el caller retorne 500 y Stripe reintente.
    throw err;
  }

  // Defensa: si la currency no es EUR, algo está mal en el flujo.
  if (expanded.currency && String(expanded.currency).toLowerCase() !== 'eur') {
    logLine({
      level: 'error',
      event_id: eventId,
      event_type: event.type,
      airtable_record_id: recordId,
      tipo: 'campus_setup_intent',
      jotform_submission_id: submissionId,
      currency: expanded.currency,
      msg: 'currency inesperada en campus_setup_intent; abort sin escribir Airtable',
    });
    return;
  }

  const pi = expanded.payment_intent && typeof expanded.payment_intent === 'object'
    ? expanded.payment_intent
    : null;
  const pm = pi && pi.payment_method && typeof pi.payment_method === 'object'
    ? pi.payment_method
    : null;
  const customer = expanded.customer && typeof expanded.customer === 'object'
    ? expanded.customer
    : null;

  const customerId = customer?.id || null;
  const pmId = pm?.id || null;
  const plan = session.metadata?.plan || 'desconocido';

  // Bloque de "Datos de transacción" (longText) — resumen humano-legible.
  const datosTransaccion = [
    `Pago automático con tarjeta — ${fecha}`,
    `Importe: ${importeEur.toFixed(2)} €`,
    `Plan: ${plan}`,
    `Stripe Customer: ${customerId || '(no disponible)'}`,
    `Stripe PaymentIntent: ${piId || '(no disponible)'}`,
    `Stripe PaymentMethod: ${pmId || '(no disponible)'}`,
    `Setup future usage: ${setupFutureUsageEnabled ? 'sí (off_session)' : 'no'}`,
    pm?.card
      ? `Tarjeta: ${pm.card.brand} •••• ${pm.card.last4} (exp ${String(pm.card.exp_month).padStart(2, '0')}/${pm.card.exp_year})`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const updates = {
    [CAMPUS_FIELDS.stripeTransactionId]: newTxId,
    [CAMPUS_FIELDS.pagadoTarjetaJotform]: importeEur,
    [CAMPUS_FIELDS.datosTransaccion]: datosTransaccion,
  };
  if (customerId) updates[CAMPUS_FIELDS.stripeCustomerId] = customerId;
  // Solo escribir el PaymentMethod ID si la tarjeta queda guardada para uso off_session.
  // Si no, el pm_id existe pero NO es reutilizable y no aporta valor.
  if (setupFutureUsageEnabled && pmId) {
    updates[CAMPUS_FIELDS.stripePaymentMethodId] = pmId;
  }

  await updateCampusRecord(recordId, updates);

  logLine({
    level: 'info',
    event_id: eventId,
    event_type: event.type,
    airtable_record_id: recordId,
    tipo: 'campus_setup_intent',
    jotform_submission_id: submissionId,
    pi_id: piId,
    pm_id: pmId,
    customer_id: customerId,
    plan,
    importe_eur: importeEur,
    setup_future_usage: setupFutureUsageEnabled,
    fecha_pago: fecha,
    msg: 'Airtable actualizado (campus_setup_intent)',
  });
}

const app = express();

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Las rutas /post-jotform y landings se montan ANTES del webhook para que cada
// una tenga su parser por defecto. El webhook usa express.raw solo en su ruta.
mountPostJotformRoutes(app, { logLine });

app.post(
  '/webhook-stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'];
    let event;
    try {
      event = constructWebhookEvent(req.body, signature, config.stripe.webhookSecret);
    } catch (err) {
      logLine({ level: 'error', msg: 'firma inválida', error: err.message });
      return res.status(400).send(`Webhook signature error: ${err.message}`);
    }

    // Caso especial: campus_setup_intent se procesa SÍNCRONO para poder devolver
    // 503 cuando el record en Airtable aún no ha sido creado por la integración
    // nativa Jotform→Airtable. Stripe reintentará con backoff exponencial.
    const isCampusSetupIntent =
      event.type === 'checkout.session.completed' &&
      event.data?.object?.metadata?.tipo === 'campus_setup_intent';

    if (isCampusSetupIntent) {
      try {
        const result = await procesarCheckoutCompleted(event);
        if (result === 'NOT_FOUND') {
          return res.status(503).send('Airtable record not found yet, please retry');
        }
        return res.status(200).json({ received: true });
      } catch (err) {
        logLine({
          level: 'error',
          event_id: event.id,
          event_type: event.type,
          msg: 'error procesando campus_setup_intent (sync)',
          error: err.message,
          stack: err.stack,
        });
        return res.status(500).send('handler error');
      }
    }

    // Resto de eventos: patrón asíncrono existente.
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
  console.log(`  GET  /post-jotform              (Phase 2)`);
  console.log(`  GET  /post-jotform/success      (Phase 2)`);
  console.log(`  GET  /post-jotform/cancel       (Phase 2)`);
  console.log(`  GET  /gracias-efectivo          (Phase 2)`);
  console.log(`  GET  /gracias-revision          (Phase 2)`);
  console.log('='.repeat(70));
  console.log(
    '\nRecuerda tener `stripe listen --forward-to localhost:' +
      port +
      '/webhook-stripe` corriendo en otra terminal (solo en local).'
  );
});
