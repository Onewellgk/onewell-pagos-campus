/**
 * Endpoint /post-jotform — receptor del Jotform de inscripción al Campus 2026.
 *
 * Flujo:
 *   1. Jotform submit → redirige a /post-jotform?sid=XXX
 *   2. Leemos la submission desde la API de Jotform (eu-api.jotform.com).
 *   3. Decidimos el flujo según los campos del formulario:
 *        - Reserva en Tarjeta + Frac2/Frac3      → Stripe Checkout con
 *                                                  payment_intent_data.setup_future_usage='off_session'
 *                                                  cuando algún plazo restante también es Tarjeta.
 *        - Reserva en Efectivo                   → /gracias-efectivo
 *        - Pago único Tarjeta (caso defensivo)   → Stripe Checkout sin setup_future_usage
 *        - Pago único Efectivo                   → /gracias-efectivo
 *        - Otros casos                           → /gracias-revision
 *   4. Stripe redirige a success_url o cancel_url al terminar.
 *
 * Integra con el webhook (scripts/04-webhook-stripe.js):
 *   - Pone metadata.tipo = 'campus_setup_intent' tanto en la session como en
 *     el PaymentIntent (para que el webhook lo reciba sea cual sea el caso).
 *   - Pone metadata.jotform_submission_id para que el webhook resuelva el
 *     record Airtable mediante findCampusBySubmissionId (la integración nativa
 *     Jotform→Airtable corre en paralelo y crea el record).
 *
 * Modo test (?test=1) protegido por config.enableTestMode (env ENABLE_TEST_MODE=true).
 * En modo test no se llama a Jotform — se usa una submission sintética hardcoded.
 */

import { stripe } from './stripe.js';
import { config, JOTFORM_QIDS } from './config.js';

// ---------- Submission sintética para modo test ----------
const SYNTHETIC_SID = '99999999999999999';

const SYNTHETIC_SUBMISSION = {
  id: SYNTHETIC_SID,
  answers: {
    [JOTFORM_QIDS.nombrePortero]: { answer: { first: 'Sintético', last: 'Test' } },
    [JOTFORM_QIDS.email]: { answer: 'test+sintetico@example.com' },
    [JOTFORM_QIDS.nombreTutor]: { answer: { first: 'Pagador', last: 'Sintético' } },
    [JOTFORM_QIDS.metodoPagoUnico]: { answer: '' },
    [JOTFORM_QIDS.plazosDePago]: { answer: 'Tres plazos' },
    [JOTFORM_QIDS.metodoRestanteFrac2]: { answer: '' },
    [JOTFORM_QIDS.metodoReserva]: { answer: 'Tarjeta (Pago seguro online)' },
    [JOTFORM_QIDS.metodoRestanteFrac3]: { answer: 'Tarjeta (Pago seguro online)' },
    [JOTFORM_QIDS.precioBase]: { answer: '450' },
    [JOTFORM_QIDS.aCobrarAhora]: { answer: '1' },
    [JOTFORM_QIDS.saldoPendiente]: { answer: '300' },
  },
};

// ---------- Helpers ----------
function readAnswer(submission, qid) {
  const a = submission?.answers?.[qid]?.answer;
  if (a == null) return '';
  if (typeof a === 'string' || typeof a === 'number') return String(a).trim();
  if (typeof a === 'object') {
    if (a.first || a.last) return `${a.first || ''} ${a.last || ''}`.trim();
    return JSON.stringify(a);
  }
  return '';
}

function parseAmount(str) {
  if (str === '' || str == null) return null;
  const cleaned = String(str).replace(/[^\d.,-]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseSubmission(submission) {
  return {
    submissionId: String(submission.id),
    nombrePortero: readAnswer(submission, JOTFORM_QIDS.nombrePortero),
    email: readAnswer(submission, JOTFORM_QIDS.email),
    nombreTutor: readAnswer(submission, JOTFORM_QIDS.nombreTutor),
    metodoPagoUnico: readAnswer(submission, JOTFORM_QIDS.metodoPagoUnico),
    plazosDePago: readAnswer(submission, JOTFORM_QIDS.plazosDePago),
    metodoRestanteFrac2: readAnswer(submission, JOTFORM_QIDS.metodoRestanteFrac2),
    metodoReserva: readAnswer(submission, JOTFORM_QIDS.metodoReserva),
    metodoRestanteFrac3: readAnswer(submission, JOTFORM_QIDS.metodoRestanteFrac3),
    precioBase: parseAmount(readAnswer(submission, JOTFORM_QIDS.precioBase)),
    aCobrarAhora: parseAmount(readAnswer(submission, JOTFORM_QIDS.aCobrarAhora)),
    saldoPendiente: parseAmount(readAnswer(submission, JOTFORM_QIDS.saldoPendiente)),
  };
}

/**
 * Decide flow + amount + setup_future_usage según los campos parseados.
 * Devuelve { flow: 'tarjeta'|'efectivo'|'unknown', plan, amountToCharge, setupFutureUsage }.
 */
function decideFlow(parsed) {
  const reserva = (parsed.metodoReserva || '').toLowerCase();
  const plazos = (parsed.plazosDePago || '').toLowerCase();
  const metodoUnico = (parsed.metodoPagoUnico || '').toLowerCase();

  const isReservaTarjeta = reserva.includes('tarjeta');
  const isPagoUnicoTarjeta = metodoUnico.includes('tarjeta');
  const esPagoUnico = plazos.includes('único') || plazos.includes('unico');
  const esTresPlazos = plazos.includes('tres');
  const plan = esPagoUnico ? 'pago_unico' : esTresPlazos ? 'frac3' : 'frac2';

  // Pago único: aquí solo deberíamos llegar para casos de efectivo (la
  // integración nativa de Jotform Stripe Checkout maneja la tarjeta de pago
  // único en Phase 2c — Q351). Si llega un pago único con tarjeta a este
  // endpoint, lo soportamos como tarjeta sin setup_future_usage por
  // robustez (no hay plazos siguientes que requieran cobro off-session).
  if (esPagoUnico) {
    if (isPagoUnicoTarjeta) {
      return {
        flow: 'tarjeta',
        plan,
        amountToCharge: parsed.precioBase,
        setupFutureUsage: false,
      };
    }
    return { flow: 'efectivo', plan, amountToCharge: 0, setupFutureUsage: false };
  }

  // Frac2 / Frac3 con reserva en efectivo → flujo efectivo.
  if (!isReservaTarjeta) {
    return { flow: 'efectivo', plan, amountToCharge: 0, setupFutureUsage: false };
  }

  // Frac2 / Frac3 con reserva en tarjeta → cobramos `aCobrarAhora` (típicamente
  // 150 EUR). setup_future_usage solo si algún plazo restante también es tarjeta;
  // si todos los plazos restantes son efectivo, no hace falta guardar la tarjeta.
  let setupFutureUsage = false;
  if (esTresPlazos) {
    const r2 = (parsed.metodoRestanteFrac2 || '').toLowerCase();
    const r3 = (parsed.metodoRestanteFrac3 || '').toLowerCase();
    setupFutureUsage = r2.includes('tarjeta') || r3.includes('tarjeta');
  } else {
    const r2 = (parsed.metodoRestanteFrac2 || '').toLowerCase();
    setupFutureUsage = r2.includes('tarjeta');
  }

  return {
    flow: 'tarjeta',
    plan,
    amountToCharge: parsed.aCobrarAhora || 150,
    setupFutureUsage,
  };
}

async function fetchSubmission(submissionId) {
  const url = `${config.jotform.baseUrl}/submission/${encodeURIComponent(submissionId)}?apiKey=${encodeURIComponent(config.jotform.apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jotform GET submission ${res.status}: ${body}`);
  }
  const json = await res.json();
  if (json.responseCode !== 200 || !json.content) {
    throw new Error(`Jotform GET submission unexpected response: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json.content;
}

/**
 * Busca por email un Customer Stripe existente; si no encuentra ninguno, crea uno
 * nuevo con email + name. Evita duplicados de Customer para repeat-buyers.
 */
async function findOrCreateStripeCustomerByEmail({ email, name }) {
  if (email) {
    const list = await stripe.customers.list({ email, limit: 1 });
    if (list.data.length > 0) return list.data[0];
  }
  const params = name ? { email, name } : { email };
  return stripe.customers.create(params);
}

async function createCheckoutSession({ submissionId, parsed, flow, isTestMode }) {
  const customer = await findOrCreateStripeCustomerByEmail({
    email: parsed.email,
    name: parsed.nombreTutor || parsed.nombrePortero,
  });

  const productName = `Reserva Gk Summer Camp PRO 2026 — ${parsed.nombrePortero || 'sin nombre'}`.slice(0, 250);
  const amountCents = Math.round(Number(flow.amountToCharge) * 100);

  const sharedMetadata = {
    tipo: 'campus_setup_intent',
    jotform_submission_id: submissionId,
    plan: flow.plan,
    setup_future_usage_enabled: String(Boolean(flow.setupFutureUsage)),
    ...(isTestMode ? { test_mode: 'true' } : {}),
  };

  const successUrl = `${config.publicBaseUrl}/post-jotform/success?sid=${encodeURIComponent(submissionId)}${isTestMode ? '&test=1' : ''}`;
  const cancelUrl = `${config.publicBaseUrl}/post-jotform/cancel?sid=${encodeURIComponent(submissionId)}${isTestMode ? '&test=1' : ''}`;

  const sessionParams = {
    mode: 'payment',
    payment_method_types: ['card'],
    customer: customer.id,
    line_items: [
      {
        price_data: {
          currency: 'eur',
          unit_amount: amountCents,
          product_data: {
            name: productName,
            metadata: {
              jotform_submission_id: submissionId,
              campus_2026: 'true',
            },
          },
        },
        quantity: 1,
      },
    ],
    metadata: sharedMetadata,
    payment_intent_data: { metadata: sharedMetadata },
    success_url: successUrl,
    cancel_url: cancelUrl,
  };

  if (flow.setupFutureUsage) {
    sessionParams.payment_intent_data.setup_future_usage = 'off_session';
  }

  return stripe.checkout.sessions.create(sessionParams);
}

// ---------- HTML helpers (páginas server-rendered) ----------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pageShell(title, bodyHtml) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
           max-width: 640px; margin: 60px auto; padding: 32px; color: #1a1a1a; line-height: 1.55; }
    h1 { color: #0a0a0a; font-size: 26px; margin-top: 0; }
    p { margin: 14px 0; }
    .box { background: #f6f6f7; border-radius: 10px; padding: 20px 24px; margin: 24px 0; }
    .box.ok { background: #ecf7ee; border-left: 4px solid #1f8a3a; }
    .box.warn { background: #fff8e6; border-left: 4px solid #c08a00; }
    code { background: #eee; padding: 2px 6px; border-radius: 4px; font-size: 0.95em; }
    a { color: #0b5fff; }
    small { color: #666; }
  </style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

// ---------- Routes ----------
/**
 * Monta las rutas del flujo /post-jotform en la app de Express dada.
 * `logLine` se inyecta para mantener el patrón de log JSON estructurado del webhook
 * sin tener que extraer el helper a un módulo compartido en este patch.
 */
export function mountPostJotformRoutes(app, { logLine }) {
  if (typeof logLine !== 'function') {
    throw new Error('mountPostJotformRoutes: falta el helper logLine');
  }

  app.get('/post-jotform', async (req, res) => {
    const submissionId = String(req.query.sid || req.query.submission_id || '').trim();
    const isTestMode = req.query.test === '1';

    if (isTestMode && !config.enableTestMode) {
      logLine({
        level: 'warn',
        route: '/post-jotform',
        sid: submissionId || null,
        msg: 'modo test rechazado (ENABLE_TEST_MODE!=true)',
      });
      return res
        .status(403)
        .type('html')
        .send(pageShell('No autorizado', `<h1>403 — No autorizado</h1><p>El modo test no está habilitado.</p>`));
    }

    if (!submissionId) {
      logLine({ level: 'warn', route: '/post-jotform', msg: 'sid ausente' });
      return res
        .status(400)
        .type('html')
        .send(
          pageShell(
            'Falta sid',
            `<h1>Falta el identificador de la inscripción</h1>
             <p>Esta página debería abrirse desde el formulario de inscripción del Campus.
             Si has llegado aquí por error, vuelve al formulario.</p>`
          )
        );
    }

    if (!config.publicBaseUrl) {
      logLine({
        level: 'error',
        route: '/post-jotform',
        sid: submissionId,
        msg: 'PUBLIC_BASE_URL no configurada — abortando',
      });
      return res
        .status(500)
        .type('html')
        .send(
          pageShell(
            'Configuración pendiente',
            `<h1>Configuración pendiente</h1>
             <p>El servidor no está completamente configurado. Avisa al equipo de Onewell
             enviando un email a <a href="mailto:info@academy.onewellgk.com">info@academy.onewellgk.com</a>.</p>`
          )
        );
    }

    try {
      const submission = isTestMode ? SYNTHETIC_SUBMISSION : await fetchSubmission(submissionId);
      const parsed = parseSubmission(submission);
      const flow = decideFlow(parsed);

      logLine({
        level: 'info',
        route: '/post-jotform',
        sid: submissionId,
        test_mode: isTestMode,
        flow: flow.flow,
        plan: flow.plan,
        amount_eur: flow.amountToCharge,
        setup_future_usage: flow.setupFutureUsage,
        msg: 'submission parseada y flow decidido',
      });

      if (flow.flow === 'efectivo') {
        return res.redirect(
          302,
          `/gracias-efectivo?sid=${encodeURIComponent(submissionId)}${isTestMode ? '&test=1' : ''}`
        );
      }

      if (flow.flow !== 'tarjeta' || !flow.amountToCharge || flow.amountToCharge <= 0) {
        logLine({
          level: 'warn',
          route: '/post-jotform',
          sid: submissionId,
          flow: flow.flow,
          plan: flow.plan,
          amount_eur: flow.amountToCharge,
          msg: 'flow indeterminado o importe inválido — redirigiendo a /gracias-revision',
          parsed_summary: {
            metodoReserva: parsed.metodoReserva,
            metodoPagoUnico: parsed.metodoPagoUnico,
            plazosDePago: parsed.plazosDePago,
          },
        });
        return res.redirect(
          302,
          `/gracias-revision?sid=${encodeURIComponent(submissionId)}${isTestMode ? '&test=1' : ''}`
        );
      }

      const session = await createCheckoutSession({ submissionId, parsed, flow, isTestMode });

      logLine({
        level: 'info',
        route: '/post-jotform',
        sid: submissionId,
        test_mode: isTestMode,
        checkout_session_id: session.id,
        customer_id: session.customer,
        amount_eur: flow.amountToCharge,
        setup_future_usage: flow.setupFutureUsage,
        msg: 'Stripe Checkout Session creada; redirigiendo al checkout',
      });

      return res.redirect(303, session.url);
    } catch (err) {
      logLine({
        level: 'error',
        route: '/post-jotform',
        sid: submissionId,
        test_mode: isTestMode,
        msg: 'error procesando submission',
        error: err.message,
        stack: err.stack,
      });
      return res
        .status(500)
        .type('html')
        .send(
          pageShell(
            'Algo ha fallado',
            `<h1>Algo ha fallado</h1>
             <p>No hemos podido procesar tu inscripción en este momento. El equipo ya está al tanto.</p>
             <p>Por favor escribe a <a href="mailto:info@academy.onewellgk.com">info@academy.onewellgk.com</a>
             indicando este código:</p>
             <p><code>${escapeHtml(submissionId)}</code></p>`
          )
        );
    }
  });

  app.get('/post-jotform/success', (_req, res) => {
    res.type('html').send(
      pageShell(
        'Pago confirmado',
        `<h1>¡Pago recibido! ✅</h1>
         <div class="box ok">
           <p><strong>Tu inscripción está confirmada.</strong></p>
           <p>En unos minutos recibirás un email con el justificante. Si no llega, revisa
           la carpeta de spam o escríbenos.</p>
         </div>
         <p>Gracias por confiar en Onewell Gk Academy. Nos vemos en el campus.</p>
         <p><small>Onewell Gk Academy · <a href="mailto:info@academy.onewellgk.com">info@academy.onewellgk.com</a></small></p>`
      )
    );
  });

  app.get('/post-jotform/cancel', (req, res) => {
    const sid = String(req.query.sid || '').trim();
    res.type('html').send(
      pageShell(
        'Pago cancelado',
        `<h1>Has cancelado el pago</h1>
         <p>Tu inscripción está registrada pero todavía sin confirmar. Tienes dos opciones:</p>
         <div class="box">
           <p><strong>Reintentar el pago.</strong> Vuelve a abrir el enlace que te enviamos por
           email o WhatsApp.</p>
           <p><strong>Pagar en efectivo.</strong> Pásate por una de nuestras sedes en horario de academia.</p>
         </div>
         <p>Si tienes dudas, escríbenos a <a href="mailto:info@academy.onewellgk.com">info@academy.onewellgk.com</a>${
           sid ? ` indicando el código <code>${escapeHtml(sid)}</code>` : ''
         }.</p>`
      )
    );
  });

  app.get('/gracias-efectivo', (_req, res) => {
    res.type('html').send(
      pageShell(
        'Inscripción registrada',
        `<h1>¡Inscripción registrada! ✅</h1>
         <div class="box ok">
           <p><strong>Has elegido pago en efectivo.</strong></p>
           <p>Pásate por una de nuestras sedes para hacer el primer pago en mano.
           Hasta entonces, tu plaza queda en espera.</p>
         </div>
         <p>El equipo se pondrá en contacto contigo en los próximos días para coordinar
         la entrega del efectivo y confirmar todos los detalles del campus.</p>
         <p><small>Onewell Gk Academy · <a href="mailto:info@academy.onewellgk.com">info@academy.onewellgk.com</a></small></p>`
      )
    );
  });

  app.get('/gracias-revision', (_req, res) => {
    res.type('html').send(
      pageShell(
        'Pendiente de revisión',
        `<h1>Inscripción recibida</h1>
         <div class="box warn">
           <p><strong>Tu inscripción está pendiente de revisión.</strong></p>
           <p>El equipo de Onewell se pondrá en contacto contigo en breve para confirmar
           los detalles del pago y del campus.</p>
         </div>
         <p><small>Onewell Gk Academy · <a href="mailto:info@academy.onewellgk.com">info@academy.onewellgk.com</a></small></p>`
      )
    );
  });
}
