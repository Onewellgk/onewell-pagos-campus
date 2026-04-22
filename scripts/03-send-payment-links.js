/**
 * Script 03 — Envío de recordatorios con Payment Link Stripe
 *
 * Para cada registro Campus cuyo próximo plazo sea en HOY + 10 días y que
 * pague ese plazo con tarjeta (o, con `--record-id <recId>`, para ese registro
 * específico, saltándose el filtro de fecha/recordatorio):
 *
 *   1. Crea/recupera Customer en Stripe.
 *   2. Crea Product + Price.
 *   3. Crea Payment Link.
 *   4. Escribe en Airtable: Stripe Customer ID, Payment Link próximo plazo.
 *   5. Envía email al tutor con el link.
 *   6. Solo si el email sale bien, marca `Recordatorio próximo plazo enviado en = NOW()`.
 *
 * Modo DRY-RUN por defecto — no crea nada en Stripe, no manda emails,
 * no toca Airtable. Se imprime el plan que se ejecutaría.
 *
 * Flags:
 *   --live                       Ejecución real.
 *   --limit N                    Procesar solo los primeros N candidatos.
 *   --record-id <recId>          Saltarse el filtro y procesar ese registro.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMPUS_FIELDS, config } from '../src/config.js';
import {
  getCampusRecord,
  listCampusCandidatosPaymentLink,
  updateCampusRecord,
} from '../src/airtable.js';
import {
  getOrCreateCustomer,
  createProductWithPrice,
  createPaymentLink,
} from '../src/stripe.js';
import { sendEmail } from '../src/email.js';
import { renderPaymentLinkEmail } from '../src/template-email.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', 'logs');

function parseArgs(argv) {
  const args = { live: false, limit: null, recordId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--limit') {
      const n = parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit requiere un número positivo`);
      }
      args.limit = n;
    } else if (a === '--record-id') {
      args.recordId = argv[++i];
      if (!args.recordId) throw new Error(`--record-id requiere un valor`);
    } else {
      throw new Error(`Argumento desconocido: ${a}`);
    }
  }
  return args;
}

function escaparCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function filenameTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Devuelve el plazo canónico ("2o" | "3o") a partir del texto de Airtable,
 * o null si no es reconocible.
 */
function plazoCanonico(textoPlazoProximo) {
  if (!textoPlazoProximo) return null;
  const t = textoPlazoProximo.toLowerCase();
  if (t.includes('2')) return '2o';
  if (t.includes('3')) return '3o';
  return null;
}

/**
 * Extrae el nombre de un campo Airtable.
 * - Strings (fórmulas, texto): devuelve la string tal cual (trim).
 * - Objetos singleSelect leídos con returnFieldsByFieldId=true: devuelve `.name`.
 * - null/undefined/otros: ''
 */
function getFieldName(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object' && typeof v.name === 'string') return v.name.trim();
  return '';
}

/**
 * Decide si el plazo actual se paga con tarjeta consultando explícitamente
 * `Plazos de pago` (singleSelect) y `Plazo próximo` (fórmula texto).
 *
 *   - Plazo próximo "2º plazo" + Plazos contiene "fraccionado en 3"
 *       → Método 2o auto-3plazos === 'Tarjeta'
 *   - Plazo próximo "2º plazo" + Plazos contiene "fraccionado en 2"
 *       → Método 2o 2plazos comienza con 'Tarjeta'
 *   - Plazo próximo "3r plazo"
 *       → Método 3r auto === 'Tarjeta'
 *
 * Cualquier otra combinación → false.
 */
function esPagoTarjeta(fields) {
  const plazoProximo = getFieldName(fields[CAMPUS_FIELDS.plazoProximo]);
  const plazosPago = getFieldName(fields[CAMPUS_FIELDS.plazosDePago]);

  if (plazoProximo === '2º plazo') {
    if (plazosPago.includes('fraccionado en 3')) {
      return getFieldName(fields[CAMPUS_FIELDS.metodoPago2o3plazos]) === 'Tarjeta';
    }
    if (plazosPago.includes('fraccionado en 2')) {
      return getFieldName(fields[CAMPUS_FIELDS.metodoPago2o2plazos]).startsWith('Tarjeta');
    }
    return false;
  }

  if (plazoProximo === '3r plazo') {
    return getFieldName(fields[CAMPUS_FIELDS.metodoPago3r3plazos]) === 'Tarjeta';
  }

  return false;
}

/**
 * Formatea la fecha ISO (YYYY-MM-DD) tal cual viene de la fórmula de Airtable.
 * Si viene un string vacío o null, devuelve null.
 */
function normalizaFechaIso(raw) {
  if (!raw) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw));
  return m ? m[1] : null;
}

async function evaluarCandidato(record) {
  const recordId = record.id;
  const f = record.fields || {};

  const titulo = f[CAMPUS_FIELDS.titulo] || '(sin título)';
  const email = (f[CAMPUS_FIELDS.emailContacto] || '').trim() || null;
  const nombreTutor = (f[CAMPUS_FIELDS.nombreTutor] || '').trim() || null;
  const apellidosTutor = (f[CAMPUS_FIELDS.apellidosTutor] || '').trim() || null;
  const nombrePortero = (f[CAMPUS_FIELDS.nombrePortero] || '').trim() || '';
  const apellidosPortero = (f[CAMPUS_FIELDS.apellidosPortero] || '').trim() || '';
  const nombreCompletoPortero = `${nombrePortero} ${apellidosPortero}`.trim() || titulo;
  const telefono = f[CAMPUS_FIELDS.telefonoContacto] || null;

  const plazoTexto = (f[CAMPUS_FIELDS.plazoProximo] || '').trim();
  const plazo = plazoCanonico(plazoTexto);
  const importe = Number(f[CAMPUS_FIELDS.importeProximoPlazo] || 0);
  const fechaIso = normalizaFechaIso(f[CAMPUS_FIELDS.fechaProximoPlazo]);
  const customerId = (f[CAMPUS_FIELDS.stripeCustomerId] || '').trim() || null;
  const recordatorio = f[CAMPUS_FIELDS.recordatorioEnviadoEn] || null;
  const paymentLinkYa = f[CAMPUS_FIELDS.paymentLinkProximoPlazo] || null;

  const motivosSkip = [];
  if (!email) motivosSkip.push('sin email de contacto');
  if (!plazo) motivosSkip.push(`plazo no reconocido ("${plazoTexto}")`);
  if (!(importe > 0)) motivosSkip.push(`importe inválido (${importe})`);
  if (!fechaIso) motivosSkip.push('fecha próximo plazo vacía');
  if (!esPagoTarjeta(f)) motivosSkip.push('método de este plazo no es Tarjeta');

  return {
    recordId,
    titulo,
    email,
    nombreTutor,
    apellidosTutor,
    nombreCompletoPortero,
    telefono,
    plazoTexto,
    plazo,
    importe,
    fechaIso,
    customerId,
    recordatorioYaEnviado: !!recordatorio,
    paymentLinkYa,
    motivosSkip,
  };
}

async function procesarLive(candidato) {
  const {
    recordId,
    titulo,
    email,
    nombreTutor,
    apellidosTutor,
    nombreCompletoPortero,
    telefono,
    plazoTexto,
    plazo,
    importe,
    fechaIso,
    customerId,
  } = candidato;

  const nombreCompletoTutor = [nombreTutor, apellidosTutor].filter(Boolean).join(' ');

  // 1. Customer
  const customer = await getOrCreateCustomer({
    existingCustomerId: customerId,
    email,
    name: nombreCompletoTutor || email,
    phone: telefono ? String(telefono) : null,
    metadata: { airtable_record_id: recordId, tipo: 'campus_2026' },
  });

  // 2. Product + Price
  const productName = `Gk Summer Camp PRO 2026 — ${plazoTexto} — ${nombreCompletoPortero}`;
  const { productId, priceId } = await createProductWithPrice({
    name: productName,
    amountEur: importe,
    metadata: { airtable_record_id: recordId, plazo, tipo: 'campus_2026' },
  });

  // 3. Payment Link
  const { id: paymentLinkId, url: paymentLinkUrl } = await createPaymentLink({
    priceId,
    metadata: {
      airtable_record_id: recordId,
      plazo,
      tipo: 'campus_2026',
    },
  });

  // 4. Airtable — antes del email, guardamos lo ganado hasta aquí.
  const patchFields = {
    [CAMPUS_FIELDS.paymentLinkProximoPlazo]: paymentLinkUrl,
  };
  if (!customerId) patchFields[CAMPUS_FIELDS.stripeCustomerId] = customer.id;
  await updateCampusRecord(recordId, patchFields);

  // 5. Email
  const { subject, html, text } = renderPaymentLinkEmail({
    nombreTutor: nombreTutor || nombreCompletoTutor || 'familia',
    nombreCompletoPortero,
    plazoProximo: plazoTexto,
    importeEur: importe,
    fechaLimiteIso: fechaIso,
    paymentLinkUrl,
  });

  const emailResult = await sendEmail({ to: email, subject, html, text });

  // 6. Marca de recordatorio enviado (solo si el email no lanzó).
  await updateCampusRecord(recordId, {
    [CAMPUS_FIELDS.recordatorioEnviadoEn]: new Date().toISOString(),
  });

  return {
    customerId: customer.id,
    customerIsNew: !customerId,
    productId,
    priceId,
    paymentLinkId,
    paymentLinkUrl,
    emailMessageId: emailResult.messageId,
  };
}

function imprimeDryRun(cand) {
  const nombreCompletoTutor = [cand.nombreTutor, cand.apellidosTutor].filter(Boolean).join(' ');
  const productName = `Gk Summer Camp PRO 2026 — ${cand.plazoTexto} — ${cand.nombreCompletoPortero}`;

  console.log(`   Plan para ${cand.recordId} (${cand.titulo}):`);
  console.log(`     - Stripe Customer: ${cand.customerId ? `REUTILIZAR ${cand.customerId}` : `CREAR (email=${cand.email}, name="${nombreCompletoTutor || cand.email}", phone=${cand.telefono ?? '—'})`}`);
  console.log(`     - Stripe Product: CREAR "${productName}"`);
  console.log(`     - Stripe Price:   CREAR ${cand.importe.toFixed(2)} EUR`);
  console.log(`     - Stripe Link:    CREAR con metadata { airtable_record_id: ${cand.recordId}, plazo: ${cand.plazo}, tipo: campus_2026 }`);
  console.log(`     - Airtable:       PATCH Payment Link + (si nuevo) Stripe Customer ID`);
  console.log(`     - Email a ${cand.email}:`);
  console.log(`         De:      ${config.email.fromName} <${config.email.from}>`);
  console.log(`         Asunto:  ${cand.plazoTexto} de pago del Gk Summer Camp PRO 2026 — ${cand.nombreCompletoPortero}`);
  console.log(`         Cuerpo:  Hola ${cand.nombreTutor || 'familia'}, importe ${cand.importe.toFixed(2).replace('.', ',')}€, fecha límite ${formatFechaEsConsola(cand.fechaIso)}, link...`);
  console.log(`     - Airtable:       PATCH Recordatorio enviado = NOW() (solo si email OK)`);
}

function formatFechaEsConsola(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return iso || '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modo = args.live ? 'LIVE' : 'DRY-RUN';

  console.log('='.repeat(70));
  console.log(`Payment Links — Campus 2026 [${modo}]`);
  if (args.recordId) console.log(`Registro específico: ${args.recordId} (se salta filtro de fecha)`);
  if (args.limit) console.log(`Límite: ${args.limit}`);
  console.log('='.repeat(70));

  let registros;
  if (args.recordId) {
    console.log(`\n→ Leyendo registro ${args.recordId}...`);
    const r = await getCampusRecord(args.recordId);
    registros = [r];
  } else {
    console.log('\n→ Buscando candidatos (fecha próximo plazo = hoy + 10 días, Madrid)...');
    registros = await listCampusCandidatosPaymentLink({ diasDesdeHoy: 10 });
  }
  console.log(`✓ ${registros.length} registro(s) a evaluar.\n`);

  if (args.limit) registros = registros.slice(0, args.limit);

  const filas = [];
  let contOk = 0;
  let contSkip = 0;
  let contError = 0;

  for (const [i, record] of registros.entries()) {
    const progreso = `[${i + 1}/${registros.length}]`;
    const cand = await evaluarCandidato(record);

    // --record-id saltea el filtro de fecha/recordatorio, pero no los checks
    // "hay email", "plazo reconocible", "método Tarjeta", etc.
    if (cand.motivosSkip.length > 0) {
      contSkip++;
      console.log(`${progreso} ·  ${cand.titulo} — SKIP: ${cand.motivosSkip.join('; ')}`);
      filas.push({
        record_id: cand.recordId,
        titulo: cand.titulo,
        estado: 'SKIP',
        plazo: cand.plazoTexto,
        importe: cand.importe,
        email_enviado_a: cand.email,
        customer_id: cand.customerId,
        payment_link: cand.paymentLinkYa,
        notas: cand.motivosSkip.join('; '),
      });
      continue;
    }

    if (!args.live) {
      console.log(`${progreso} +  ${cand.titulo} — DRY-RUN`);
      imprimeDryRun(cand);
      filas.push({
        record_id: cand.recordId,
        titulo: cand.titulo,
        estado: 'DRY_RUN_OK',
        plazo: cand.plazoTexto,
        importe: cand.importe,
        email_enviado_a: cand.email,
        customer_id: cand.customerId || '(a crear)',
        payment_link: '(a crear)',
        notas: '',
      });
      contOk++;
    } else {
      console.log(`${progreso} →  ${cand.titulo} — ejecutando live...`);
      try {
        const r = await procesarLive(cand);
        contOk++;
        console.log(`   ✓ customer=${r.customerId}${r.customerIsNew ? ' (nuevo)' : ''}`);
        console.log(`   ✓ product=${r.productId} price=${r.priceId}`);
        console.log(`   ✓ payment_link=${r.paymentLinkUrl}`);
        console.log(`   ✓ email enviado (messageId=${r.emailMessageId})`);
        filas.push({
          record_id: cand.recordId,
          titulo: cand.titulo,
          estado: 'LISTO',
          plazo: cand.plazoTexto,
          importe: cand.importe,
          email_enviado_a: cand.email,
          customer_id: r.customerId,
          payment_link: r.paymentLinkUrl,
          notas: r.customerIsNew ? 'customer nuevo' : 'customer reutilizado',
        });
      } catch (err) {
        contError++;
        console.log(`   ✗ ERROR: ${err.message}`);
        filas.push({
          record_id: cand.recordId,
          titulo: cand.titulo,
          estado: 'ERROR',
          plazo: cand.plazoTexto,
          importe: cand.importe,
          email_enviado_a: cand.email,
          customer_id: cand.customerId,
          payment_link: cand.paymentLinkYa,
          notas: err.message,
        });
      }
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  // CSV
  mkdirSync(LOGS_DIR, { recursive: true });
  const sufijo = args.live ? 'live' : 'dryrun';
  const csvFile = join(LOGS_DIR, `03-payment-links-${sufijo}-${filenameTimestamp()}.csv`);

  const headers = [
    'record_id',
    'titulo',
    'estado',
    'plazo',
    'importe',
    'customer_id',
    'payment_link',
    'email_enviado_a',
    'notas',
  ];
  const csvContent = [
    headers.join(','),
    ...filas.map((f) => headers.map((h) => escaparCSV(f[h])).join(',')),
  ].join('\n');
  writeFileSync(csvFile, '﻿' + csvContent, 'utf8');

  console.log('\n' + '='.repeat(70));
  console.log('RESUMEN');
  console.log('='.repeat(70));
  console.log(`  Modo                       : ${modo}`);
  console.log(`  Registros evaluados        : ${registros.length}`);
  console.log(`  +  OK${args.live ? ' (enviados)' : ' (plan válido)'}      : ${contOk}`);
  console.log(`  ·  SKIP                    : ${contSkip}`);
  console.log(`  ✗  ERROR                   : ${contError}`);
  console.log('='.repeat(70));
  console.log(`\n✓ CSV generado: ${csvFile}`);
}

main().catch((err) => {
  console.error('\n✗ Error fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
