/**
 * Plantillas de email del flujo de recovery (Phase 2c).
 *
 * Dos plantillas:
 *  1. renderRecoveryEmail()        — para la familia. Se manda cuando una
 *     inscripción quedó en `⚠️ Pendiente reserva tarjeta` (la familia rellenó
 *     el Jotform pero no completó el pago de la reserva con tarjeta).
 *  2. renderDireccionNotificationEmail() — para el equipo de coordinación. Se manda
 *     cuando han pasado 24h desde el email anterior sin que la familia haya
 *     pagado, para que un coordinador retome la inscripción manualmente.
 *
 * Ambas plantillas devuelven { subject, html, text } listos para `sendEmail()`
 * de `src/email.js`. La aproximación HTML es deliberadamente sobria (sin
 * imágenes, sin grids, sin estilos exóticos) para máxima compatibilidad con
 * clientes de correo y para no disparar filtros de spam.
 */

// ---------- Helpers compartidos ----------
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function firstName(fullName) {
  const trimmed = String(fullName ?? '').trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0];
}

function formatFechaHoraEs(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

// ---------- Email 1: recovery a la familia ----------
/**
 * @param {object} params
 * @param {string} params.nombreTutor              Nombre completo del tutor (se usa el primer nombre).
 * @param {string} params.nombreCompletoPortero    "Nombre + Apellidos" del portero.
 * @param {string} params.paymentLinkUrl           URL del Stripe Payment Link.
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderRecoveryEmail({ nombreTutor, nombreCompletoPortero, paymentLinkUrl }) {
  const tutor = firstName(nombreTutor) || 'hola';
  const portero = String(nombreCompletoPortero || '').trim() || 'tu hijo/a';
  const linkSafe = escapeAttr(paymentLinkUrl);

  const subject = 'Completa tu inscripción al Gk Summer Camp PRO';

  const html = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;color:#1a1a1a;line-height:1.55;max-width:560px;margin:0 auto;padding:24px;">
<p>Hola ${escapeHtml(tutor)},</p>

<p>Hemos recibido los datos de inscripción de <strong>${escapeHtml(portero)}</strong>
al <strong>Gk Summer Camp PRO 2026</strong>, pero el pago de la reserva (150 €) no se ha
completado.</p>

<p>Para finalizar la inscripción, completa el pago aquí:</p>

<p style="margin:24px 0;">
  <a href="${linkSafe}"
     style="display:inline-block;background:#0b5fff;color:#fff;text-decoration:none;
            padding:12px 24px;border-radius:6px;font-weight:600;">
    Pagar la reserva (150 €)
  </a>
</p>

<p style="font-size:13px;color:#555;">Si el botón no funciona, copia y pega esta URL en tu navegador:<br>
<a href="${linkSafe}">${linkSafe}</a></p>

<p>Si tienes algún problema o prefieres pagar de otra forma, responde a este
email y te ayudamos.</p>

<p>Un saludo,<br>Equipo Onewell Gk Academy</p>
</body>
</html>`;

  const text = [
    `Hola ${tutor},`,
    '',
    `Hemos recibido los datos de inscripción de ${portero} al Gk Summer Camp PRO 2026,`,
    `pero el pago de la reserva (150 €) no se ha completado.`,
    '',
    `Para finalizar la inscripción, paga aquí:`,
    paymentLinkUrl,
    '',
    `Si tienes algún problema o prefieres pagar de otra forma, responde a este`,
    `email y te ayudamos.`,
    '',
    `Un saludo,`,
    `Equipo Onewell Gk Academy`,
  ].join('\n');

  return { subject, html, text };
}

// ---------- Email 2: notificación al equipo de coordinación ----------
/**
 * @param {object} params
 * @param {string} params.nombreCompletoPortero    "Nombre + Apellidos" del portero.
 * @param {string} params.nombreTutor              Nombre completo del tutor.
 * @param {string|null} params.emailFamilia        Email del tutor (para contactar).
 * @param {string|null} params.telefonoFamilia     Teléfono del tutor.
 * @param {string} params.airtableRecordUrl        URL al record en Airtable.
 * @param {string} params.paymentLinkUrl           URL del PL ya enviado a la familia.
 * @param {string|null} params.recoveryEnviadoEnIso  Timestamp del envío del email a la familia (ISO).
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderDireccionNotificationEmail({
  nombreCompletoPortero,
  nombreTutor,
  emailFamilia,
  telefonoFamilia,
  airtableRecordUrl,
  paymentLinkUrl,
  recoveryEnviadoEnIso,
}) {
  const portero = String(nombreCompletoPortero || '').trim() || '(sin nombre)';
  const tutor = String(nombreTutor || '').trim() || '(sin nombre)';
  const fechaEnvio = formatFechaHoraEs(recoveryEnviadoEnIso) || '(desconocida)';

  const subject = `[Recovery] Familia sin pagar tras 24h: ${portero}`;

  const datosLista = [
    `Portero: ${portero}`,
    `Tutor: ${tutor}`,
    emailFamilia ? `Email: ${emailFamilia}` : null,
    telefonoFamilia ? `Teléfono: ${telefonoFamilia}` : null,
    `Email recovery enviado: ${fechaEnvio}`,
  ].filter(Boolean);

  const html = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;line-height:1.55;max-width:600px;margin:0 auto;padding:24px;">

<p>Una familia que se inscribió al Gk Summer Camp PRO 2026 con pago de
reserva por tarjeta <strong>no ha completado el pago</strong> y han pasado
más de 24 horas desde que se le envió el email de recovery automático.</p>

<p>Es posible que necesite seguimiento manual (WhatsApp, llamada, otro método de pago).</p>

<p><strong>Datos de la inscripción:</strong></p>
<ul style="padding-left:20px;">
${datosLista.map((l) => `  <li>${escapeHtml(l)}</li>`).join('\n')}
</ul>

<p style="margin-top:20px;">
  <a href="${escapeAttr(airtableRecordUrl)}"
     style="display:inline-block;background:#1f1f1f;color:#fff;text-decoration:none;
            padding:10px 18px;border-radius:6px;font-weight:600;font-size:14px;">
    Abrir el record en Airtable
  </a>
</p>

<p style="font-size:13px;color:#555;">Si decides gestionar este caso manualmente y no quieres que el sistema vuelva a actuar,
marca el flag <strong>Comunicación manual</strong> en el record. El email de recovery a la familia ya
contiene el Payment Link siguiente:<br>
<a href="${escapeAttr(paymentLinkUrl)}">${escapeAttr(paymentLinkUrl)}</a></p>

<p style="font-size:12px;color:#888;margin-top:32px;">
Notificación automática enviada por el sistema de recovery del Gk Summer Camp PRO 2026.
</p>

</body>
</html>`;

  const text = [
    `Una familia que se inscribió al Gk Summer Camp PRO 2026 con pago de reserva`,
    `por tarjeta no ha completado el pago y han pasado más de 24 horas desde que`,
    `se le envió el email de recovery automático.`,
    '',
    `Es posible que necesite seguimiento manual.`,
    '',
    `Datos de la inscripción:`,
    ...datosLista.map((l) => `  - ${l}`),
    '',
    `Record en Airtable:`,
    airtableRecordUrl,
    '',
    `Payment Link enviado a la familia:`,
    paymentLinkUrl,
    '',
    `Si gestionas este caso manualmente, marca el flag "Comunicación manual"`,
    `en el record para que el sistema no vuelva a actuar.`,
  ].join('\n');

  return { subject, html, text };
}
