import { config, JOTFORM_QIDS } from './config.js';

/**
 * Recupera un submission de Jotform por ID.
 * Devuelve un objeto normalizado con los campos que nos interesan.
 * Si falla, lanza error con detalle.
 */
export async function getJotformSubmission(submissionId) {
  if (!submissionId) {
    throw new Error('Submission ID vacío');
  }

  const url = `${config.jotform.baseUrl}/submission/${submissionId}?apiKey=${config.jotform.apiKey}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Jotform API ${res.status} para submission ${submissionId}`);
  }

  const data = await res.json();

  if (data.responseCode !== 200) {
    throw new Error(`Jotform responseCode ${data.responseCode}: ${data.message}`);
  }

  const answers = data.content?.answers || {};
  return parseAnswers(answers);
}

/**
 * Extrae los campos relevantes del bloque `answers` de Jotform.
 */
function parseAnswers(answers) {
  const email = answers[JOTFORM_QIDS.email]?.answer?.trim() || null;

  const tel1Raw = answers[JOTFORM_QIDS.telefono1]?.answer;
  const tel2Raw = answers[JOTFORM_QIDS.telefono2]?.answer;
  const telefono1 = typeof tel1Raw === 'string' ? tel1Raw.trim() || null : null;
  const telefono2 = typeof tel2Raw === 'string' ? tel2Raw.trim() || null : null;

  // Email que Stripe registró en el momento del pago (cross-check)
  let emailStripe = null;
  const stripeCheckout = answers[JOTFORM_QIDS.stripeCheckout]?.answer;
  if (stripeCheckout?.paymentArray) {
    try {
      const parsed = JSON.parse(stripeCheckout.paymentArray);
      emailStripe = parsed?.email || parsed?.stripeCheckoutData?.email || null;
    } catch {
      // paymentArray no siempre es JSON válido — silencioso
    }
  }

  const nombreAnswer = answers[JOTFORM_QIDS.nombreTutor]?.answer;
  const tutorFirst =
    typeof nombreAnswer?.first === 'string'
      ? nombreAnswer.first.trim() || null
      : null;
  const tutorLast =
    typeof nombreAnswer?.last === 'string'
      ? nombreAnswer.last.trim() || null
      : null;
  const nombreCompleto = [tutorFirst, tutorLast].filter(Boolean).join(' ') || null;

  const dniRaw = answers[JOTFORM_QIDS.dniTutor]?.answer;
  const dniTutor = typeof dniRaw === 'string' ? dniRaw.trim() || null : null;

  const direccionRaw = answers[JOTFORM_QIDS.direccion]?.answer;
  const direccion = formatDireccion(direccionRaw);

  return {
    email,
    emailStripe,
    telefono1,
    telefono2,
    nombreTutor: nombreCompleto,
    tutorFirst,
    tutorLast,
    dniTutor,
    direccion,
  };
}

/**
 * Formatea QID 380 (objeto { addr_line1, addr_line2, city, state, postal, country })
 * en una cadena multilínea:
 *   {addr_line1}[, {addr_line2}]
 *   {postal} {city}, {state}
 *   {country}
 * Salta componentes vacíos sin dejar comas ni líneas sueltas.
 */
function formatDireccion(addr) {
  if (!addr || typeof addr !== 'object') return null;
  const clean = (s) => (typeof s === 'string' ? s.trim() : '');

  const line1 = [clean(addr.addr_line1), clean(addr.addr_line2)]
    .filter(Boolean)
    .join(', ');

  const cityPostal = [clean(addr.postal), clean(addr.city)]
    .filter(Boolean)
    .join(' ');
  const state = clean(addr.state);
  const line2 = [cityPostal, state].filter(Boolean).join(', ');

  const line3 = clean(addr.country);

  const lines = [line1, line2, line3].filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : null;
}