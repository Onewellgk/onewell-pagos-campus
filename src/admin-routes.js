/**
 * Endpoints `/admin/*` — flujo de recovery (Phase 2c).
 *
 * Diseñados para ser llamados desde Airtable Automations vía la acción
 * "Run a script" (que permite headers custom). Autenticación con header
 * `X-Admin-Token`, comparado tiempo-constante contra `config.adminApiToken`.
 *
 * Endpoints:
 *
 *   POST /admin/recovery-link-and-send
 *     Body:    { recordId: "rec..." }
 *     Headers: X-Admin-Token: <secret>
 *     Acción:  (1) crea Stripe Customer (find-or-create por email), (2) crea
 *              Stripe Payment Link de 150 € con metadata para enrutar al
 *              webhook como `campus_setup_intent`, (3) escribe la URL en
 *              `Payment Link Reserva`, (4) manda email a la familia vía
 *              Resend, (5) marca `Recovery email enviado en` con timestamp.
 *     Idempotente: si el record ya tiene `Recovery email enviado en`,
 *                  devuelve 200 con `skipped: true` sin reenviar.
 *
 *   POST /admin/notify-uri-recovery
 *     Body:    { recordId: "rec..." }
 *     Headers: X-Admin-Token: <secret>
 *     Acción:  manda email al equipo de coordinación
 *              (`config.recoveryNotifyEmail`) y marca
 *              `Recovery Uri notificado en` con timestamp.
 *     Idempotente: si el record ya tiene `Recovery Uri notificado en`,
 *                  devuelve 200 con `skipped: true` sin reenviar.
 *
 * Defensive checks (ambos endpoints):
 *   - El header X-Admin-Token coincide. → 401 si no.
 *   - El body contiene `recordId`.       → 400 si no.
 *   - El record existe en Airtable.      → 404 si no.
 *   - `Comunicación manual` está unchecked. → 409 si está chequeado.
 *
 * Adicionales sólo para `/admin/recovery-link-and-send`:
 *   - `Estado pago reserva` es exactamente '⚠️ Pendiente reserva tarjeta'. → 409 si no.
 *
 * Adicionales sólo para `/admin/notify-uri-recovery`:
 *   - `Recovery email enviado en` está rellenado (debió enviarse antes). → 409 si no.
 *
 * Las respuestas siempre son JSON. Errores incluyen `{error, code}` para que
 * el "Run a script" de Airtable pueda interpretarlos sin parsear texto.
 */

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { stripe } from './stripe.js';
import { config, CAMPUS_FIELDS } from './config.js';
import { getCampusRecord, updateCampusRecord } from './airtable.js';
import { sendEmail } from './email.js';
import { renderRecoveryEmail, renderDireccionNotificationEmail } from './email-recovery.js';

const ESTADO_PENDIENTE_TARJETA = '⚠️ Pendiente reserva tarjeta';

// ---------- Auth ----------
function tokensMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  // timingSafeEqual exige misma longitud — si difieren, devolvemos false sin
  // hacer la comparación para no exponer la longitud del token correcto.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function buildAuthMiddleware({ logLine }) {
  return (req, res, next) => {
    if (!config.adminApiToken) {
      // Defensa: en producción ADMIN_API_TOKEN tiene que estar configurada,
      // o estos endpoints quedan deshabilitados completamente. Devolvemos 503
      // (servicio no disponible) en vez de 401 para que sea visible en logs
      // del Airtable Automation que falta configuración del lado servidor.
      logLine({
        level: 'error',
        route: req.path,
        msg: 'ADMIN_API_TOKEN no configurada — endpoint admin deshabilitado',
      });
      return res.status(503).json({
        error: 'ADMIN_API_TOKEN no configurada en el servidor',
        code: 'admin_token_not_configured',
      });
    }

    const provided = req.headers['x-admin-token'];
    if (!tokensMatch(provided, config.adminApiToken)) {
      logLine({
        level: 'warn',
        route: req.path,
        msg: 'X-Admin-Token inválido o ausente',
        has_header: Boolean(provided),
      });
      return res.status(401).json({
        error: 'Token de administración inválido',
        code: 'invalid_admin_token',
      });
    }

    next();
  };
}

// ---------- Helpers comunes ----------
function airtableRecordUrl(recordId) {
  return `https://airtable.com/${config.airtable.baseId}/${config.airtable.tableCampus}/${recordId}`;
}

function fullName(first, last) {
  return [first, last].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');
}

/**
 * Lee el record de Airtable y extrae los campos relevantes para el flujo
 * de recovery, normalizados (strings vacíos como '' en vez de undefined).
 */
async function fetchAndNormalize(recordId) {
  const record = await getCampusRecord(recordId);
  const f = record.fields || {};

  return {
    record,
    recordId: record.id,
    nombrePortero: String(f[CAMPUS_FIELDS.nombrePortero] ?? '').trim(),
    apellidosPortero: String(f[CAMPUS_FIELDS.apellidosPortero] ?? '').trim(),
    nombreTutor: String(f[CAMPUS_FIELDS.nombreTutor] ?? '').trim(),
    apellidosTutor: String(f[CAMPUS_FIELDS.apellidosTutor] ?? '').trim(),
    emailContacto: String(f[CAMPUS_FIELDS.emailContacto] ?? '').trim(),
    telefonoContacto: f[CAMPUS_FIELDS.telefonoContacto] ?? null,
    jotformSubmissionId: String(f[CAMPUS_FIELDS.jotformSubmissionId] ?? '').trim(),
    estadoPagoReserva: String(f[CAMPUS_FIELDS.estadoPagoReserva] ?? '').trim(),
    paymentLinkReserva: String(f[CAMPUS_FIELDS.paymentLinkReserva] ?? '').trim(),
    comunicacionManual: Boolean(f[CAMPUS_FIELDS.comunicacionManual]),
    recoveryEmailEnviadoEn: f[CAMPUS_FIELDS.recoveryEmailEnviadoEn] ?? null,
    recoveryUriNotificadoEn: f[CAMPUS_FIELDS.recoveryUriNotificadoEn] ?? null,
    stripeCustomerId: String(f[CAMPUS_FIELDS.stripeCustomerId] ?? '').trim(),
    plazosDePago: String(f[CAMPUS_FIELDS.plazosDePago] ?? '').trim(),
  };
}

/**
 * Find-or-create de Stripe Customer por email. Replica el patrón usado en
 * `src/post-jotform.js` para consistencia (un Customer por familia).
 * Si no hay email disponible, crea un Customer sin email.
 */
async function findOrCreateStripeCustomerByEmail({ email, name }) {
  if (email) {
    const list = await stripe.customers.list({ email, limit: 1 });
    if (list.data.length > 0) return list.data[0];
  }
  const params = name ? { email, name } : { email };
  return stripe.customers.create(params);
}

// ---------- Endpoint 1: recovery-link-and-send ----------
async function handleRecoveryLinkAndSend(req, res, { logLine }) {
  const recordId = String(req.body?.recordId || '').trim();

  if (!recordId || !/^rec[A-Za-z0-9]{14}$/.test(recordId)) {
    logLine({
      level: 'warn',
      route: '/admin/recovery-link-and-send',
      msg: 'recordId ausente o malformado',
      received: req.body?.recordId,
    });
    return res.status(400).json({
      error: 'recordId requerido y debe coincidir con el formato rec...',
      code: 'invalid_record_id',
    });
  }

  let normalized;
  try {
    normalized = await fetchAndNormalize(recordId);
  } catch (err) {
    if (String(err.message).includes('404') || String(err.message).includes('NOT_FOUND')) {
      logLine({
        level: 'warn',
        route: '/admin/recovery-link-and-send',
        airtable_record_id: recordId,
        msg: 'record no encontrado en Airtable',
      });
      return res.status(404).json({
        error: 'Record no encontrado en Airtable',
        code: 'record_not_found',
      });
    }
    throw err;
  }

  const {
    nombrePortero,
    apellidosPortero,
    nombreTutor,
    emailContacto,
    estadoPagoReserva,
    paymentLinkReserva,
    comunicacionManual,
    recoveryEmailEnviadoEn,
    jotformSubmissionId,
    plazosDePago,
  } = normalized;

  // Defensive checks
  if (comunicacionManual) {
    logLine({
      level: 'info',
      route: '/admin/recovery-link-and-send',
      airtable_record_id: recordId,
      msg: 'record marcado como Comunicación manual; skip',
    });
    return res.status(409).json({
      error: 'Record marcado como Comunicación manual; el sistema no actuará',
      code: 'manual_communication_flagged',
    });
  }

  if (estadoPagoReserva !== ESTADO_PENDIENTE_TARJETA) {
    logLine({
      level: 'info',
      route: '/admin/recovery-link-and-send',
      airtable_record_id: recordId,
      estado_pago_reserva: estadoPagoReserva,
      msg: 'estado no es ⚠️ Pendiente reserva tarjeta; skip',
    });
    return res.status(409).json({
      error: `Estado pago reserva es "${estadoPagoReserva}" — solo se procesa "${ESTADO_PENDIENTE_TARJETA}"`,
      code: 'invalid_estado_pago_reserva',
      currentEstado: estadoPagoReserva,
    });
  }

  if (recoveryEmailEnviadoEn) {
    logLine({
      level: 'info',
      route: '/admin/recovery-link-and-send',
      airtable_record_id: recordId,
      recovery_enviado_en: recoveryEmailEnviadoEn,
      msg: 'email de recovery ya fue enviado previamente; skip (idempotencia)',
    });
    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: 'already_sent',
      recoveryEmailEnviadoEn,
      paymentLinkUrl: paymentLinkReserva || null,
    });
  }

  if (!emailContacto) {
    logLine({
      level: 'warn',
      route: '/admin/recovery-link-and-send',
      airtable_record_id: recordId,
      msg: 'record sin email de contacto; no se puede enviar recovery',
    });
    return res.status(409).json({
      error: 'El record no tiene email de contacto; no se puede enviar recovery',
      code: 'missing_contact_email',
    });
  }

  if (!jotformSubmissionId) {
    // Defensa: si no hay sid, el webhook no podrá enrutar el pago al record
    // correcto. Mejor abortar que crear un PL huérfano.
    logLine({
      level: 'warn',
      route: '/admin/recovery-link-and-send',
      airtable_record_id: recordId,
      msg: 'record sin Jotform Submission ID; el webhook no podría enrutarlo',
    });
    return res.status(409).json({
      error: 'El record no tiene Jotform Submission ID; no se puede vincular el pago',
      code: 'missing_jotform_submission_id',
    });
  }

  const nombreCompletoPortero = fullName(nombrePortero, apellidosPortero) || '(sin nombre)';

  // Decisión de setup_future_usage según los plazos. Si hay plazos restantes
  // por pagar (Frac2 o Frac3), guardamos la tarjeta para cobros off_session.
  // Para pago único o si no podemos determinarlo, no la guardamos.
  // (Replica la lógica de `decideFlow` en post-jotform.js.)
  const plazosLower = plazosDePago.toLowerCase();
  const esPagoUnico = plazosLower.includes('único') || plazosLower.includes('unico');
  const setupFutureUsage = !esPagoUnico; // Frac2/Frac3 → guardar tarjeta

  // 1. Find-or-create Customer (idempotente por email).
  let customer;
  try {
    customer = await findOrCreateStripeCustomerByEmail({
      email: emailContacto,
      name: nombreTutor || nombreCompletoPortero,
    });
  } catch (err) {
    logLine({
      level: 'error',
      route: '/admin/recovery-link-and-send',
      airtable_record_id: recordId,
      msg: 'error creando/buscando Stripe Customer',
      error: err.message,
    });
    return res.status(502).json({
      error: 'No se pudo crear el cliente en Stripe',
      code: 'stripe_customer_error',
      detail: err.message,
    });
  }

  // 2. Crear Stripe Payment Link.
  const productName = `Reserva Gk Summer Camp PRO 2026 — ${nombreCompletoPortero}`.slice(0, 250);

  const sharedMetadata = {
    tipo: 'campus_setup_intent',
    jotform_submission_id: jotformSubmissionId,
    plan: esPagoUnico ? 'pago_unico' : 'frac_recovery',
    setup_future_usage_enabled: String(setupFutureUsage),
    source: 'admin_recovery',
  };

  const successUrl = config.publicBaseUrl
    ? `${config.publicBaseUrl}/post-jotform/success?sid=${encodeURIComponent(jotformSubmissionId)}`
    : null;

  let paymentLink;
  try {
    // Usamos price_data inline (no hace falta crear un Price persistente para
    // un único uso). El PL queda restringido a 1 sesión completada.
    const product = await stripe.products.create({
      name: productName,
      metadata: {
        jotform_submission_id: jotformSubmissionId,
        airtable_record_id: recordId,
        source: 'admin_recovery',
      },
    });
    const price = await stripe.prices.create({
      currency: 'eur',
      unit_amount: 15000,
      product: product.id,
    });

    const paymentLinkParams = {
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: sharedMetadata,
      payment_intent_data: {
        metadata: sharedMetadata,
        ...(setupFutureUsage ? { setup_future_usage: 'off_session' } : {}),
      },
      restrictions: {
        completed_sessions: { limit: 1 },
      },
      ...(customer.id ? { customer_creation: 'always' } : {}),
      ...(successUrl
        ? {
            after_completion: {
              type: 'redirect',
              redirect: { url: successUrl },
            },
          }
        : {}),
    };

    paymentLink = await stripe.paymentLinks.create(paymentLinkParams);
  } catch (err) {
    logLine({
      level: 'error',
      route: '/admin/recovery-link-and-send',
      airtable_record_id: recordId,
      msg: 'error creando Stripe Payment Link',
      error: err.message,
    });
    return res.status(502).json({
      error: 'No se pudo crear el Payment Link en Stripe',
      code: 'stripe_payment_link_error',
      detail: err.message,
    });
  }

  // 3. Escribir Payment Link en Airtable + customer si lo tenemos.
  const updates = {
    [CAMPUS_FIELDS.paymentLinkReserva]: paymentLink.url,
  };
  if (customer.id && !normalized.stripeCustomerId) {
    updates[CAMPUS_FIELDS.stripeCustomerId] = customer.id;
  }
  try {
    await updateCampusRecord(recordId, updates);
  } catch (err) {
    logLine({
      level: 'error',
      route: '/admin/recovery-link-and-send',
      airtable_record_id: recordId,
      payment_link_url: paymentLink.url,
      msg: 'error escribiendo Payment Link en Airtable',
      error: err.message,
    });
    return res.status(502).json({
      error: 'Payment Link creado en Stripe pero falló escritura en Airtable',
      code: 'airtable_write_error',
      paymentLinkUrl: paymentLink.url,
      detail: err.message,
    });
  }

  // 4. Componer y enviar email.
  const { subject, html, text } = renderRecoveryEmail({
    nombreTutor,
    nombreCompletoPortero,
    paymentLinkUrl: paymentLink.url,
  });

  let messageId;
  try {
    const result = await sendEmail({
      to: emailContacto,
      subject,
      html,
      text,
    });
    messageId = result.messageId;
  } catch (err) {
    logLine({
      level: 'error',
      route: '/admin/recovery-link-and-send',
      airtable_record_id: recordId,
      payment_link_url: paymentLink.url,
      msg: 'error enviando email de recovery',
      error: err.message,
    });
    // El PL ya está en Airtable; el coordinador puede reenviar manualmente
    // copiando ese link. No marcamos `Recovery email enviado en` para que
    // un retry de la automation pueda reintentar el envío.
    return res.status(502).json({
      error: 'Payment Link creado pero email no se pudo enviar',
      code: 'email_send_error',
      paymentLinkUrl: paymentLink.url,
      detail: err.message,
    });
  }

  // 5. Marcar Recovery email enviado en con timestamp para idempotencia.
  const sentAtIso = new Date().toISOString();
  try {
    await updateCampusRecord(recordId, {
      [CAMPUS_FIELDS.recoveryEmailEnviadoEn]: sentAtIso,
    });
  } catch (err) {
    // Email ya enviado pero no pudimos marcar el timestamp. Logueamos
    // como warning pero devolvemos 200 (el efecto principal —pago y
    // notificación— ya ocurrió). Una segunda automation podría reenviar;
    // el coordinador puede marcar `Comunicación manual` si pasa.
    logLine({
      level: 'warn',
      route: '/admin/recovery-link-and-send',
      airtable_record_id: recordId,
      message_id: messageId,
      msg: 'email enviado pero falló marcar Recovery email enviado en',
      error: err.message,
    });
  }

  logLine({
    level: 'info',
    route: '/admin/recovery-link-and-send',
    airtable_record_id: recordId,
    payment_link_url: paymentLink.url,
    payment_link_id: paymentLink.id,
    customer_id: customer.id,
    message_id: messageId,
    sent_to: emailContacto,
    setup_future_usage: setupFutureUsage,
    sent_at: sentAtIso,
    msg: 'recovery email enviado correctamente',
  });

  return res.status(200).json({
    ok: true,
    skipped: false,
    paymentLinkUrl: paymentLink.url,
    paymentLinkId: paymentLink.id,
    customerId: customer.id,
    messageId,
    sentAt: sentAtIso,
    sentTo: emailContacto,
  });
}

// ---------- Endpoint 2: notify-uri-recovery ----------
async function handleNotifyUriRecovery(req, res, { logLine }) {
  const recordId = String(req.body?.recordId || '').trim();

  if (!recordId || !/^rec[A-Za-z0-9]{14}$/.test(recordId)) {
    logLine({
      level: 'warn',
      route: '/admin/notify-uri-recovery',
      msg: 'recordId ausente o malformado',
      received: req.body?.recordId,
    });
    return res.status(400).json({
      error: 'recordId requerido y debe coincidir con el formato rec...',
      code: 'invalid_record_id',
    });
  }

  let normalized;
  try {
    normalized = await fetchAndNormalize(recordId);
  } catch (err) {
    if (String(err.message).includes('404') || String(err.message).includes('NOT_FOUND')) {
      logLine({
        level: 'warn',
        route: '/admin/notify-uri-recovery',
        airtable_record_id: recordId,
        msg: 'record no encontrado en Airtable',
      });
      return res.status(404).json({
        error: 'Record no encontrado en Airtable',
        code: 'record_not_found',
      });
    }
    throw err;
  }

  const {
    nombrePortero,
    apellidosPortero,
    nombreTutor,
    apellidosTutor,
    emailContacto,
    telefonoContacto,
    paymentLinkReserva,
    comunicacionManual,
    recoveryEmailEnviadoEn,
    recoveryUriNotificadoEn,
  } = normalized;

  if (comunicacionManual) {
    logLine({
      level: 'info',
      route: '/admin/notify-uri-recovery',
      airtable_record_id: recordId,
      msg: 'record marcado como Comunicación manual; skip',
    });
    return res.status(409).json({
      error: 'Record marcado como Comunicación manual; el sistema no actuará',
      code: 'manual_communication_flagged',
    });
  }

  if (!recoveryEmailEnviadoEn) {
    logLine({
      level: 'info',
      route: '/admin/notify-uri-recovery',
      airtable_record_id: recordId,
      msg: 'no hay email de recovery previo; no se notifica a Uri (sería prematuro)',
    });
    return res.status(409).json({
      error: 'No hay email de recovery previo; no procede notificar a coordinación todavía',
      code: 'recovery_email_not_sent',
    });
  }

  if (recoveryUriNotificadoEn) {
    logLine({
      level: 'info',
      route: '/admin/notify-uri-recovery',
      airtable_record_id: recordId,
      ya_notificado_en: recoveryUriNotificadoEn,
      msg: 'Uri ya fue notificado previamente; skip (idempotencia)',
    });
    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: 'already_notified',
      recoveryUriNotificadoEn,
    });
  }

  // Componer email.
  const nombreCompletoPortero = fullName(nombrePortero, apellidosPortero) || '(sin nombre)';
  const nombreTutorCompleto = fullName(nombreTutor, apellidosTutor) || '(sin nombre)';
  const telefonoStr = telefonoContacto != null && telefonoContacto !== '' ? String(telefonoContacto) : null;

  const { subject, html, text } = renderDireccionNotificationEmail({
    nombreCompletoPortero,
    nombreTutor: nombreTutorCompleto,
    emailFamilia: emailContacto || null,
    telefonoFamilia: telefonoStr,
    airtableRecordUrl: airtableRecordUrl(recordId),
    paymentLinkUrl: paymentLinkReserva || '(no disponible)',
    recoveryEnviadoEnIso: recoveryEmailEnviadoEn,
  });

  let messageId;
  try {
    const result = await sendEmail({
      to: config.recoveryNotifyEmail,
      subject,
      html,
      text,
    });
    messageId = result.messageId;
  } catch (err) {
    logLine({
      level: 'error',
      route: '/admin/notify-uri-recovery',
      airtable_record_id: recordId,
      msg: 'error enviando notificación a coordinación',
      error: err.message,
    });
    return res.status(502).json({
      error: 'No se pudo enviar la notificación de coordinación',
      code: 'email_send_error',
      detail: err.message,
    });
  }

  const notifiedAtIso = new Date().toISOString();
  try {
    await updateCampusRecord(recordId, {
      [CAMPUS_FIELDS.recoveryUriNotificadoEn]: notifiedAtIso,
    });
  } catch (err) {
    logLine({
      level: 'warn',
      route: '/admin/notify-uri-recovery',
      airtable_record_id: recordId,
      message_id: messageId,
      msg: 'notificación enviada pero falló marcar Recovery Uri notificado en',
      error: err.message,
    });
  }

  logLine({
    level: 'info',
    route: '/admin/notify-uri-recovery',
    airtable_record_id: recordId,
    sent_to: config.recoveryNotifyEmail,
    message_id: messageId,
    notified_at: notifiedAtIso,
    msg: 'notificación a coordinación enviada correctamente',
  });

  return res.status(200).json({
    ok: true,
    skipped: false,
    sentTo: config.recoveryNotifyEmail,
    messageId,
    notifiedAt: notifiedAtIso,
  });
}

// ---------- Mount ----------
/**
 * Monta los endpoints /admin/* en la app Express dada.
 * `logLine` se inyecta para mantener el formato de log JSON estructurado del
 * webhook (mismo patrón que mountPostJotformRoutes).
 */
export function mountAdminRoutes(app, { logLine }) {
  if (typeof logLine !== 'function') {
    throw new Error('mountAdminRoutes: falta el helper logLine');
  }

  const auth = buildAuthMiddleware({ logLine });
  // express.json() local — no afecta a /webhook-stripe que usa express.raw.
  const jsonParser = express.json({ limit: '32kb' });

  app.post('/admin/recovery-link-and-send', jsonParser, auth, (req, res, next) => {
    handleRecoveryLinkAndSend(req, res, { logLine }).catch(next);
  });

  app.post('/admin/notify-uri-recovery', jsonParser, auth, (req, res, next) => {
    handleNotifyUriRecovery(req, res, { logLine }).catch(next);
  });
}
