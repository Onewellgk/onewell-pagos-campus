/**
 * Script 01 — Auditoría de emails
 *
 * Solo lectura. Compara emails en Campus vs Jotform y genera un CSV
 * con el diagnóstico. No modifica nada.
 *
 * Uso:
 *   npm run audit:emails
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, CAMPUS_FIELDS } from '../src/config.js';
import { listCampusConSaldoPendiente } from '../src/airtable.js';
import { getJotformSubmission } from '../src/jotform.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', 'logs');

function normaliza(str) {
  if (!str) return null;
  return String(str).trim().toLowerCase();
}

function emailMismoValor(a, b) {
  return normaliza(a) === normaliza(b);
}

function clasifica({ emailAirtable, emailJotform }) {
  if (!emailJotform) {
    if (!emailAirtable) return 'SIN_EMAIL_EN_JOTFORM';
    return 'SIN_EMAIL_EN_JOTFORM'; // Jotform no tiene, Airtable sí → raro, lo flaggeamos
  }
  if (!emailAirtable) return 'BACKFILL';
  if (emailMismoValor(emailAirtable, emailJotform)) return 'OK';
  return 'CONFLICTO';
}

function escaparCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Si contiene coma, comilla o salto de línea, escapar con comillas dobles
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function filenameTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function main() {
  console.log('='.repeat(70));
  console.log('Auditoría de emails — Campus 2026');
  console.log(`DRY_RUN: ${config.dryRun} (siempre solo lectura en este script)`);
  console.log('='.repeat(70));

  console.log('\n→ Leyendo registros Campus con saldo pendiente > 0...');
  const campusRecords = await listCampusConSaldoPendiente();
  console.log(`✓ ${campusRecords.length} registros encontrados.\n`);

  const filas = [];
  let contOK = 0;
  let contBackfill = 0;
  let contConflicto = 0;
  let contSinJotform = 0;
  let contError = 0;
  let contSinSubmission = 0;

  for (const [i, record] of campusRecords.entries()) {
    const recordId = record.id;
    const f = record.fields;
    const titulo = f[CAMPUS_FIELDS.titulo] || '(sin título)';
    const emailAirtable = f[CAMPUS_FIELDS.emailContacto] || null;
    const telefonoAirtable = f[CAMPUS_FIELDS.telefonoContacto] || null;
    const submissionIdRaw = f[CAMPUS_FIELDS.jotformSubmissionId];
    // El Submission ID puede venir como string o array; normalizamos
    const submissionId = Array.isArray(submissionIdRaw)
      ? submissionIdRaw[0]
      : submissionIdRaw;

    const progreso = `[${i + 1}/${campusRecords.length}]`;

    if (!submissionId) {
      contSinSubmission++;
      console.log(`${progreso} ⚠  ${titulo} — SIN_SUBMISSION_ID`);
      filas.push({
        record_id: recordId,
        titulo,
        estado: 'SIN_SUBMISSION_ID',
        email_airtable: emailAirtable,
        email_jotform: null,
        email_stripe: null,
        telefono_airtable: telefonoAirtable,
        telefono_jotform: null,
        submission_id: null,
        notas: 'El registro Campus no tiene Jotform Submission ID',
      });
      continue;
    }

    try {
      const jf = await getJotformSubmission(submissionId);
      const estado = clasifica({
        emailAirtable,
        emailJotform: jf.email,
      });

      const notas = [];
      if (jf.email && jf.emailStripe && !emailMismoValor(jf.email, jf.emailStripe)) {
        notas.push(`Email Jotform (${jf.email}) ≠ email Stripe (${jf.emailStripe})`);
      }
      if (estado === 'CONFLICTO') {
        notas.push(`Airtable: ${emailAirtable} | Jotform: ${jf.email}`);
      }

      filas.push({
        record_id: recordId,
        titulo,
        estado,
        email_airtable: emailAirtable,
        email_jotform: jf.email,
        email_stripe: jf.emailStripe,
        telefono_airtable: telefonoAirtable,
        telefono_jotform: jf.telefono1,
        submission_id: submissionId,
        notas: notas.join(' | '),
      });

      if (estado === 'OK') contOK++;
      else if (estado === 'BACKFILL') contBackfill++;
      else if (estado === 'CONFLICTO') contConflicto++;
      else if (estado === 'SIN_EMAIL_EN_JOTFORM') contSinJotform++;

      const icono =
        estado === 'OK'
          ? '✓'
          : estado === 'BACKFILL'
            ? '+'
            : estado === 'CONFLICTO'
              ? '✗'
              : '?';
      console.log(`${progreso} ${icono} ${titulo} — ${estado}`);
    } catch (err) {
      contError++;
      console.log(`${progreso} ✗ ${titulo} — ERROR_JOTFORM: ${err.message}`);
      filas.push({
        record_id: recordId,
        titulo,
        estado: 'ERROR_JOTFORM',
        email_airtable: emailAirtable,
        email_jotform: null,
        email_stripe: null,
        telefono_airtable: telefonoAirtable,
        telefono_jotform: null,
        submission_id: submissionId,
        notas: err.message,
      });
    }

    // Pausa mínima entre llamadas a Jotform para no saturar la API
    await new Promise((r) => setTimeout(r, 100));
  }

  // Escribir CSV
  mkdirSync(LOGS_DIR, { recursive: true });
  const csvFile = join(LOGS_DIR, `auditoria-emails-${filenameTimestamp()}.csv`);

  const headers = [
    'record_id',
    'titulo',
    'estado',
    'email_airtable',
    'email_jotform',
    'email_stripe',
    'telefono_airtable',
    'telefono_jotform',
    'submission_id',
    'notas',
  ];

  const csvContent = [
    headers.join(','),
    ...filas.map((fila) =>
      headers.map((h) => escaparCSV(fila[h])).join(',')
    ),
  ].join('\n');

  // BOM para que Excel abra UTF-8 correctamente
  writeFileSync(csvFile, '\uFEFF' + csvContent, 'utf8');

  console.log('\n' + '='.repeat(70));
  console.log('RESUMEN');
  console.log('='.repeat(70));
  console.log(`  Total analizados       : ${campusRecords.length}`);
  console.log(`  ✓ OK (coinciden)       : ${contOK}`);
  console.log(`  + BACKFILL (a rellenar): ${contBackfill}`);
  console.log(`  ✗ CONFLICTO            : ${contConflicto}`);
  console.log(`  ? Sin email en Jotform : ${contSinJotform}`);
  console.log(`  ! Sin submission ID    : ${contSinSubmission}`);
  console.log(`  ⚠  Errores Jotform API : ${contError}`);
  console.log('='.repeat(70));
  console.log(`\n✓ CSV generado: ${csvFile}`);
}

main().catch((err) => {
  console.error('\n✗ Error fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});