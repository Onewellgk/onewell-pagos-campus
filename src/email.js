import { Resend } from 'resend';
import { config } from './config.js';

const resend = new Resend(config.email.resendApiKey);

/**
 * Envía un email vía Resend. El SDK devuelve `{data, error}` en vez de lanzar;
 * aquí lo normalizamos a excepción para que el script 03 pueda hacer rollback
 * (no marcar "Recordatorio enviado en" si el envío falló).
 *
 * @param {{to: string, subject: string, html: string, text?: string}} params
 * @returns {Promise<{messageId: string}>}
 */
export async function sendEmail({ to, subject, html, text }) {
  const fromString = `${config.email.fromName} <${config.email.from}>`;
  const result = await resend.emails.send({
    from: fromString,
    to: [to],
    subject,
    html,
    text,
  });

  if (result.error) {
    const detail =
      result.error.message || JSON.stringify(result.error);
    throw new Error(`Resend error: ${detail}`);
  }

  return { messageId: result.data?.id };
}
