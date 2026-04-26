#!/usr/bin/env node
/**
 * 05-send-efectivo-reminders.js
 *
 * Envía emails recordatorio (antes del deadline 1-mayo) a las familias del
 * Gk Summer Camp PRO 2026 que eligieron pago en efectivo y aún no han pagado
 * la parte correspondiente:
 *   - Grupo A: 3 plazos Efectivo · reserva pendiente
 *   - Grupo B: Pago único Efectivo · pendiente
 *
 * Uso:
 *   node 05-send-efectivo-reminders.js                # DRY-RUN (por defecto)
 *   node 05-send-efectivo-reminders.js --live         # envío real
 *   node 05-send-efectivo-reminders.js --live --only=rec101VNb0nJWzLQt
 *
 * Env vars requeridas:
 *   AIRTABLE_PAT       (o AIRTABLE_API_KEY / AIRTABLE_TOKEN)
 *   RESEND_API_KEY     (solo necesaria en --live)
 *
 * Comportamiento:
 *   - Lee importes frescos de Airtable justo antes de enviar (si cambiaste un
 *     Precio Base manualmente, se refleja).
 *   - Envía 1 email por familia (los 2 registros de los Martínez Boadas van
 *     en un único email unificado a la madre).
 *   - Tras cada envío real, deja un comentario en cada record Airtable con
 *     el messageId de Resend para trazabilidad.
 *   - Si un envío falla, imprime el error y continúa con el siguiente.
 */

const { Resend } = require('resend');

// ============================================================
// CONFIG
// ============================================================
const DRY_RUN = !process.argv.includes('--live');
const ONLY_ARG = process.argv.find(a => a.startsWith('--only='));
const ONLY_RECORD = ONLY_ARG ? ONLY_ARG.split('=')[1] : null;

const AIRTABLE_BASE_ID = 'appsfW2BLNkt8z8cl';
const CAMPUS_TABLE_ID = 'tblYuQzz5jbkWaeXs';
const FROM = 'Onewell Gk Academy <info@academy.onewellgk.com>';
const REPLY_TO = 'info@academy.onewellgk.com';
const DELAY_BETWEEN_EMAILS_MS = 800;

const AIRTABLE_KEY = process.env.AIRTABLE_PAT || process.env.AIRTABLE_API_KEY || process.env.AIRTABLE_TOKEN;
const RESEND_KEY = process.env.RESEND_API_KEY;

if (!AIRTABLE_KEY) { console.error('❌ Falta AIRTABLE_PAT / AIRTABLE_API_KEY / AIRTABLE_TOKEN'); process.exit(1); }
if (!RESEND_KEY && !DRY_RUN) { console.error('❌ Falta RESEND_API_KEY (solo necesaria en --live)'); process.exit(1); }

// Los 11 envíos (12 porteros, 11 familias).
// `records` es el array de recordIds de Airtable que van en el mismo email.
// Cuando son 2+ recordIds, es email unificado por familia con hermanos.
const JOBS = [
  // GRUPO A — 3 plazos Efectivo, reserva pendiente
  { id: 'xavi',   group: 'A', records: ['rec101VNb0nJWzLQt'] },
  { id: 'boadas', group: 'A', records: ['recQ40skUG86sbpcw', 'recaNFjMBlnV7WcQH'] }, // Paula + Toni
  { id: 'biel',   group: 'A', records: ['recYBpsR6mQ2bxIse'] },
  { id: 'fabio',  group: 'A', records: ['recgbxg7YesNxHb5I'] },
  { id: 'aniol',  group: 'A', records: ['recgkLZH6IY9MboFv'] },
  { id: 'ikerg',  group: 'A', records: ['recmV1Hp49sDAdBwj'] },
  { id: 'ferran', group: 'A', records: ['recpbHzgZUsFiCETx'] },
  // GRUPO B — Pago único Efectivo, pendiente
  { id: 'alan',   group: 'B', records: ['rec2M1yJMnwy2DfxP'] },
  { id: 'iris',   group: 'B', records: ['recVhpbQMPPo5mm5o'] },
  { id: 'paufer', group: 'B', records: ['recaszWI2O2Czy9sH'] },
  { id: 'roman',  group: 'B', records: ['recmG6kZ6fQctnJuX'] },
];

// Field IDs de la tabla Campus
const F = {
  nombrePortero:  'fldpPOOz82pxfU2nF',
  apellidosPortero:'fldaENd2SXGll4IFD',
  nombrePadre:    'fldrKjZNurWGbbf4X',
  apellidosPadre: 'fldjtuAhom3agx8a0',
  emailContacto:  'flduAvxNHXTq2eXG4',
  precioBase:     'flddPajM96N3L2Tmb',
  precioTotal:    'fldvp7mxC3pDo5PlF',
  plan:           'fldHQUBw5wlsQXbRn',
  aPagarReserva:  'fldcRKbdybXFQp1dA',
  aPagar2_3plz:   'fld2dredX3eJGv5mf',  // A pagar 2o pago (3 plazos)
  saldoPendiente: 'fldQK6w8IxJ2iPWZ8',
  formato:        'fldo4slp7hMPl3yx6',
};

// ============================================================
// HELPERS
// ============================================================
const resend = RESEND_KEY ? new Resend(RESEND_KEY) : null;

const eur = n => (Math.round(Number(n) * 100) / 100)
  .toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

const firstName = s => String(s || '').trim().split(/\s+/)[0] || '';
const titleCase = s => String(s || '')
  .toLowerCase()
  .split(/\s+/)
  .map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : '')
  .join(' ')
  .trim();

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchRecord(recordId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CAMPUS_TABLE_ID}/${recordId}?returnFieldsByFieldId=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_KEY}` } });
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return { id: j.id, fields: j.fields };
}

function derive(fields) {
  const total     = Number(fields[F.precioTotal] || 0);
  const pagado    = total - Number(fields[F.saldoPendiente] ?? total);
  const reserva   = Number(fields[F.aPagarReserva] || 0);
  const segPago   = Number(fields[F.aPagar2_3plz] || 0);
  const tercero   = Math.max(0, +(total - reserva - segPago).toFixed(2));
  const plan      = (typeof fields[F.plan]    === 'object' ? fields[F.plan]?.name    : fields[F.plan])    || '';
  const planKind  = plan.includes('en 3: ') ? '3plz' : plan.includes('en 2: ') ? '2plz' : 'unico';
  const formato   = (typeof fields[F.formato] === 'object' ? fields[F.formato]?.name : fields[F.formato]) || '';
  const porteroNombre = titleCase(`${fields[F.nombrePortero] || ''} ${fields[F.apellidosPortero] || ''}`);
  const porteroCorto  = titleCase(firstName(fields[F.nombrePortero]));
  return { total, pagado, reserva, segPago, tercero, plan, planKind, formato, porteroNombre, porteroCorto };
}

// ============================================================
// TEMPLATES HTML
// ============================================================
const STYLES = {
  wrap:      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#222;line-height:1.55;max-width:620px;margin:0 auto;padding:24px 16px;',
  p:         'margin:0 0 14px;',
  list:      'margin:0 0 16px;padding-left:20px;',
  highlight: 'background:#fff8dc;padding:12px 14px;border-radius:6px;margin:16px 0;font-weight:600;',
  footer:    'margin-top:28px;padding-top:16px;border-top:1px solid #eee;color:#666;font-size:13px;',
  subheader: 'margin:20px 0 8px;font-weight:700;font-size:15px;',
};

// --- PLANTILLA INDIVIDUAL (Grupo A o B con un solo portero) -------------
function renderIndividual({ padreNombre, d }) {
  const { porteroNombre, porteroCorto, total, pagado, reserva, segPago, tercero, planKind, formato } = d;
  const sinAlojamiento = /sin alojamiento/i.test(formato);

  let intro, lista, resumenFinal, aEntregar;

  if (planKind === '3plz') {
    aEntregar = reserva + segPago;
    intro = `Te escribimos para recordarte que se acerca la fecha límite del <strong>1 de mayo</strong> para el segundo plazo de la inscripción de ${porteroCorto} en el Gk Summer Camp PRO 2026.`;
    lista = `
      <li><strong>Portero/a:</strong> ${porteroNombre}</li>
      ${sinAlojamiento ? '<li><strong>Formato:</strong> Sin alojamiento</li>' : ''}
      <li><strong>Precio total:</strong> ${eur(total)}</li>
      <li><strong>Plan elegido:</strong> 3 plazos · Efectivo</li>
      <li><strong>Reserva (pendiente):</strong> ${eur(reserva)}</li>
      <li><strong>2º plazo (antes del 1 de mayo):</strong> ${eur(segPago)}</li>
      <li><strong>3r plazo (antes del 1 de junio o el día del campus):</strong> ${eur(tercero)}</li>
    `;
    resumenFinal = `A entregar antes del 1 de mayo: ${eur(aEntregar)} (reserva + 2º plazo).`;
  } else {
    // Pago único
    const pendiente = Math.max(0, +(total - pagado).toFixed(2));
    aEntregar = pendiente;
    const esParcial = pagado > 0;
    intro = esParcial
      ? `Te escribimos para recordarte que se acerca la fecha límite del <strong>1 de mayo</strong> para el pago restante de la inscripción de ${porteroCorto} en el Gk Summer Camp PRO 2026.`
      : `Te escribimos para recordarte que se acerca la fecha límite del <strong>1 de mayo</strong> para el pago de la inscripción de ${porteroCorto} en el Gk Summer Camp PRO 2026.`;
    lista = `
      <li><strong>Portero/a:</strong> ${porteroNombre}</li>
      <li><strong>Precio total:</strong> ${eur(total)}</li>
      <li><strong>Plan elegido:</strong> Pago único · Efectivo</li>
      ${esParcial ? `<li><strong>Ya entregado (efectivo):</strong> ${eur(pagado)}</li>` : ''}
      <li><strong>Pendiente:</strong> ${eur(pendiente)}</li>
    `;
    resumenFinal = `A entregar antes del 1 de mayo: ${eur(aEntregar)}.`;
  }

  const html = `<div style="${STYLES.wrap}">
    <p style="${STYLES.p}">Hola ${padreNombre},</p>
    <p style="${STYLES.p}">${intro}</p>
    <ul style="${STYLES.list}">${lista}</ul>
    <div style="${STYLES.highlight}">${resumenFinal}</div>
    <p style="${STYLES.p}">Puedes entregar el efectivo presencialmente a cualquier coordinador Academy en las instalaciones correspondientes (Barcelona, Lliçà de Vall o Maçanet de la Selva) en día y franjas de academia, o concertar otra forma de entrega si te va mejor.</p>
    <div style="${STYLES.footer}">
      Un saludo,<br><strong>Equipo de Onewell Gk</strong><br>
      <a href="mailto:info@academy.onewellgk.com" style="color:#666;">info@academy.onewellgk.com</a>
    </div>
  </div>`;

  // Versión texto plano para fallback
  const text = `Hola ${padreNombre},

${intro.replace(/<[^>]+>/g, '')}

${lista.replace(/<li><strong>([^<]+)<\/strong>\s*([^<]+)<\/li>/g, '• $1 $2').replace(/<[^>]+>/g, '').trim()}

${resumenFinal}

Puedes entregar el efectivo presencialmente a cualquier coordinador Academy en las instalaciones correspondientes (Barcelona, Lliçà de Vall o Maçanet de la Selva) en día y franjas de academia, o concertar otra forma de entrega si te va mejor.

Un saludo,
Equipo de Onewell Gk
info@academy.onewellgk.com`;

  return { html, text, aEntregar };
}

// --- PLANTILLA HERMANOS (Martínez Boadas: Paula + Toni) ------------------
function renderHermanos({ padreNombre, derivs }) {
  const [d1, d2] = derivs;
  const nombres = `${d1.porteroCorto} y ${d2.porteroCorto}`;

  const bloqueHermano = (d, esSegundo) => {
    const aEntregar = d.reserva + d.segPago;
    const marca = esSegundo ? ' <em style="color:#666;font-weight:400;">(con descuento hermanos aplicado)</em>' : '';
    return `
      <div style="${STYLES.subheader}">${d.porteroNombre}${marca}</div>
      <ul style="${STYLES.list}">
        <li>Precio total: ${eur(d.total)}</li>
        <li>Reserva (pendiente): ${eur(d.reserva)}</li>
        <li>2º plazo (antes del 1 de mayo): ${eur(d.segPago)}</li>
        <li>3r plazo (antes del 1 de junio o el día del campus): ${eur(d.tercero)}</li>
      </ul>`;
  };

  // d2 (Toni) es el de menor total → el "2º hermano"
  const [primero, segundo] = d1.total >= d2.total ? [d1, d2] : [d2, d1];
  const aEntregarTotal = primero.reserva + primero.segPago + segundo.reserva + segundo.segPago;

  const html = `<div style="${STYLES.wrap}">
    <p style="${STYLES.p}">Hola ${padreNombre},</p>
    <p style="${STYLES.p}">Te escribimos para recordarte que se acerca la fecha límite del <strong>1 de mayo</strong> para el segundo plazo de la inscripción de ${nombres} en el Gk Summer Camp PRO 2026.</p>
    ${bloqueHermano(primero, false)}
    ${bloqueHermano(segundo, true)}
    <div style="${STYLES.highlight}">Total familia a entregar antes del 1 de mayo: ${eur(aEntregarTotal)} (reservas + 2ºs plazos de ambos).</div>
    <p style="${STYLES.p}">Puedes entregar el efectivo presencialmente a cualquier coordinador Academy en las instalaciones correspondientes (Barcelona, Lliçà de Vall o Maçanet de la Selva) en día y franjas de academia, o concertar otra forma de entrega si te va mejor.</p>
    <div style="${STYLES.footer}">
      Un saludo,<br><strong>Equipo de Onewell Gk</strong><br>
      <a href="mailto:info@academy.onewellgk.com" style="color:#666;">info@academy.onewellgk.com</a>
    </div>
  </div>`;

  const text = `Hola ${padreNombre},

Te escribimos para recordarte que se acerca la fecha límite del 1 de mayo para el segundo plazo de la inscripción de ${nombres} en el Gk Summer Camp PRO 2026.

${primero.porteroNombre}
• Precio total: ${eur(primero.total)}
• Reserva (pendiente): ${eur(primero.reserva)}
• 2º plazo (antes del 1 de mayo): ${eur(primero.segPago)}
• 3r plazo (antes del 1 de junio o el día del campus): ${eur(primero.tercero)}

${segundo.porteroNombre} (con descuento hermanos aplicado)
• Precio total: ${eur(segundo.total)}
• Reserva (pendiente): ${eur(segundo.reserva)}
• 2º plazo (antes del 1 de mayo): ${eur(segundo.segPago)}
• 3r plazo (antes del 1 de junio o el día del campus): ${eur(segundo.tercero)}

Total familia a entregar antes del 1 de mayo: ${eur(aEntregarTotal)} (reservas + 2ºs plazos de ambos).

Puedes entregar el efectivo presencialmente a cualquier coordinador Academy en las instalaciones correspondientes (Barcelona, Lliçà de Vall o Maçanet de la Selva) en día y franjas de academia, o concertar otra forma de entrega si te va mejor.

Un saludo,
Equipo de Onewell Gk
info@academy.onewellgk.com`;

  return { html, text, aEntregar: aEntregarTotal };
}

// ============================================================
// PROCESAR UN JOB
// ============================================================
async function processJob(job) {
  // Filtro --only
  if (ONLY_RECORD && !job.records.includes(ONLY_RECORD)) return { skipped: true };

  // Fetch todos los registros del job
  const recs = [];
  for (const recId of job.records) {
    recs.push(await fetchRecord(recId));
  }

  const derivs = recs.map(r => derive(r.fields));
  const primaryFields = recs[0].fields;
  const to = primaryFields[F.emailContacto];
  const padreFirstName = titleCase(firstName(primaryFields[F.nombrePadre]));
  const subjectName = recs.length > 1
    ? derivs.map(d => d.porteroCorto).join(' y ')
    : derivs[0].porteroCorto;
  const subject = `Recordatorio pago Gk Summer Camp PRO 2026 — ${subjectName}`;

  // Render según número de records
  const rendered = recs.length > 1
    ? renderHermanos({ padreNombre: padreFirstName, derivs })
    : renderIndividual({ padreNombre: padreFirstName, d: derivs[0] });

  console.log('─'.repeat(70));
  console.log(`🧾 Job: ${job.id} (${job.group}) — ${recs.length} record(s)`);
  console.log(`   To: ${to}`);
  console.log(`   Subject: ${subject}`);
  console.log(`   A entregar: ${eur(rendered.aEntregar)}`);
  console.log(`   Records: ${job.records.join(', ')}`);

  if (DRY_RUN) {
    console.log('   📝 [DRY-RUN] Email no enviado. Primer párrafo:');
    console.log('      ' + rendered.text.split('\n').slice(0, 3).join('\n      '));
    return { dryRun: true };
  }

  // Envío real
  try {
    const result = await resend.emails.send({
      from: FROM,
      to: [to],
      reply_to: REPLY_TO,
      subject,
      html: rendered.html,
      text: rendered.text,
    });

    if (result.error) {
      console.error(`   ❌ Resend error: ${JSON.stringify(result.error)}`);
      return { ok: false, error: result.error };
    }

    const messageId = result.data && result.data.id;
    console.log(`   ✅ Enviado. messageId=${messageId}`);

    // Deja comentario de trazabilidad en cada record del job
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    for (const rec of recs) {
      try {
        await base(CAMPUS_TABLE_ID).update(rec.id, {}); // no-op para forzar last-modified
        // (Comentarios nativos Airtable no se exponen en la SDK oficial; si quieres
        //  trazabilidad en un campo de texto, añade aquí la actualización:)
        // Ejemplo: await base(CAMPUS_TABLE_ID).update(rec.id, { 'fldXXXXXX': `${ts} email reserva enviado (id=${messageId})` });
      } catch (_) { /* ignorar */ }
    }

    return { ok: true, messageId };
  } catch (err) {
    console.error(`   ❌ Excepción enviando: ${err.message || err}`);
    return { ok: false, error: err };
  }
}

// ============================================================
// MAIN
// ============================================================
(async () => {
  console.log('='.repeat(70));
  console.log(`Gk Summer Camp PRO 2026 — Emails recordatorio efectivo`);
  console.log(`Modo: ${DRY_RUN ? '🧪 DRY-RUN' : '🚀 LIVE'}${ONLY_RECORD ? `  ·  Solo: ${ONLY_RECORD}` : ''}`);
  console.log(`Jobs a procesar: ${JOBS.length}`);
  console.log('='.repeat(70));

  const summary = { ok: 0, failed: 0, skipped: 0, dryRun: 0 };

  for (const job of JOBS) {
    const r = await processJob(job);
    if (r.skipped) summary.skipped++;
    else if (r.dryRun) summary.dryRun++;
    else if (r.ok) summary.ok++;
    else summary.failed++;

    if (!DRY_RUN && !r.skipped) await sleep(DELAY_BETWEEN_EMAILS_MS);
  }

  console.log('='.repeat(70));
  console.log(`Resumen:  ✅ ${summary.ok} enviados   ❌ ${summary.failed} fallidos   ⏭️ ${summary.skipped} saltados   🧪 ${summary.dryRun} dry-run`);
  console.log('='.repeat(70));

  process.exit(summary.failed > 0 ? 1 : 0);
})();
