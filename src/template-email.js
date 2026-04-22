/**
 * Renderiza el email de recordatorio de Payment Link.
 *
 * @param {object} params
 * @param {string} params.nombreTutor          Nombre del tutor (solo nombre, no apellidos).
 * @param {string} params.nombreCompletoPortero "Nombre + Apellidos" del portero.
 * @param {string} params.plazoProximo         Texto tal cual de Airtable ("2º plazo" | "3r plazo").
 * @param {number} params.importeEur           Importe en EUR (p.ej. 322.50).
 * @param {string} params.fechaLimiteIso       Fecha límite en formato 'YYYY-MM-DD'.
 * @param {string} params.paymentLinkUrl       URL del Payment Link de Stripe.
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderPaymentLinkEmail({
  nombreTutor,
  nombreCompletoPortero,
  plazoProximo,
  importeEur,
  fechaLimiteIso,
  paymentLinkUrl,
}) {
  const importeFmt = formatImporteEur(importeEur);
  const fechaFmt = formatFechaEs(fechaLimiteIso);

  const subject = `${plazoProximo} de pago del Gk Summer Camp PRO 2026 — ${nombreCompletoPortero}`;

  const html = `<p>Hola ${escapeHtml(nombreTutor)},</p>
<p>Te escribimos para recordarte que el ${escapeHtml(plazoProximo)} de la inscripción de ${escapeHtml(nombreCompletoPortero)} al Gk Summer Camp PRO 2026 está próximo. Los datos son:</p>
<ul>
  <li><strong>Importe:</strong> ${importeFmt} €</li>
  <li><strong>Fecha límite:</strong> ${fechaFmt}</li>
  <li><strong>Método de pago:</strong> Tarjeta</li>
</ul>
<p>Puedes completar el pago de forma segura a través del siguiente enlace: <a href="${paymentLinkUrl}">Pagar ahora</a></p>
<p>Una vez realizado el pago recibirás automáticamente un justificante de Stripe por email.</p>
<p>Si tienes cualquier duda, estamos a tu disposición.</p>
<p>Un saludo,<br>Onewell Gk</p>`;

  const text = `Hola ${nombreTutor},

Te escribimos para recordarte que el ${plazoProximo} de la inscripción de ${nombreCompletoPortero} al Gk Summer Camp PRO 2026 está próximo. Los datos son:

- Importe: ${importeFmt} €
- Fecha límite: ${fechaFmt}
- Método de pago: Tarjeta

Puedes completar el pago de forma segura aquí:
${paymentLinkUrl}

Una vez realizado el pago recibirás automáticamente un justificante de Stripe por email.
Si tienes cualquier duda, estamos a tu disposición.

Un saludo,
Onewell Gk`;

  return { subject, html, text };
}

/**
 * Formato español con coma decimal y dos decimales. "322.5" -> "322,50".
 */
function formatImporteEur(n) {
  return Number(n).toFixed(2).replace('.', ',');
}

/**
 * 'YYYY-MM-DD' -> 'DD/MM/YYYY' (estándar español con cero a la izquierda).
 */
function formatFechaEs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return iso || '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
