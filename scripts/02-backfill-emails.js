/**
 * Script 02 — Backfill desde Jotform
 *
 * Lista registros Campus con saldo > 0. Para cada uno, consulta el
 * submission de Jotform y rellena en Airtable solo los campos que
 * estén vacíos (no sobrescribe lo que el coordinador haya puesto a mano).
 *
 * Campos rellenados:
 *   - email (QID 31)
 *   - teléfono 1 y 2 (QID 480/481, como número)
 *   - nombre del tutor (QID 199 .first)
 *   - apellidos del tutor (QID 199 .last)
 *   - DNI del tutor (QID 200)
 *   - dirección (QID 380, formateada en multilinea)
 *
 * Teléfonos: Airtable los guarda como `number`. Se limpian espacios,
 * paréntesis, guiones y el `+` inicial. Si el resultado no es un
 * número puro, se omite ese campo.
 *
 * Uso:
 *   npm run backfill:emails                   # dry-run completo
 *   npm run backfill:emails -- --limit 5      # dry-run de 5
 *   npm run backfill:emails -- --live --limit 5
 *   npm run backfill:emails -- --live         # todos los pendientes
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMPUS_FIELDS } from '../src/config.js';
import {
  listCampusConSaldoPendiente,
  updateCampusRecords,
} from '../src/airtable.js';
import { getJotformSubmission } from '../src/jotform.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', 'logs');

function parseArgs(argv) {
  const args = { live: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') {
      args.live = true;
    } else if (a === '--limit') {
      const raw = argv[i + 1];
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit requiere un número positivo (recibido: ${raw})`);
      }
      args.limit = n;
      i++;
    } else {
      throw new Error(`Argumento desconocido: ${a}`);
    }
  }
  return args;
}

/**
 * Convierte un teléfono en string (tal como viene de Jotform) a un
 * número apto para Airtable. Devuelve null si no es numérico puro
 * tras limpiar espacios, paréntesis, guiones y el `+`.
 */
function telefonoANumero(raw) {
  if (typeof raw !== 'string') return null;
  const limpio = raw.replace(/[\s()\-+]/g, '');
  if (limpio === '' || !/^\d+$/.test(limpio)) return null;
  const num = Number(limpio);
  if (!Number.isFinite(num)) return null;
  return num;
}

function escaparCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
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
  const args = parseArgs(process.argv.slice(2));
  const modo = args.live ? 'LIVE' : 'DRY-RUN';

  console.log('='.repeat(70));
  console.log(`Backfill de emails y teléfonos — Campus 2026 [${modo}]`);
  if (args.limit) console.log(`Límite: ${args.limit} registros`);
  console.log('='.repeat(70));

  console.log('\n→ Leyendo registros Campus con saldo pendiente > 0...');
  const campusRecords = await listCampusConSaldoPendiente();
  console.log(`✓ ${campusRecords.length} registros con saldo pendiente.`);

  // Candidatos = todos los registros con saldo > 0.
  // La lógica por-campo se encarga de no sobrescribir lo ya relleno.
  const candidatos = campusRecords;
  console.log(`→ ${candidatos.length} candidatos (todos los saldo > 0).`);

  const lista = args.limit ? candidatos.slice(0, args.limit) : candidatos;
  console.log(`→ A procesar: ${lista.length}.\n`);

  const filas = [];
  const updates = [];
  let contListos = 0;
  let contSinCambios = 0;
  let contSinSubmission = 0;
  let contError = 0;

  for (const [i, record] of lista.entries()) {
    const recordId = record.id;
    const f = record.fields;
    const titulo = f[CAMPUS_FIELDS.titulo] || '(sin título)';
    const emailActual = f[CAMPUS_FIELDS.emailContacto] || null;
    const tel1Actual = f[CAMPUS_FIELDS.telefonoContacto];
    const tel2Actual = f[CAMPUS_FIELDS.telefonoContacto2];

    const submissionIdRaw = f[CAMPUS_FIELDS.jotformSubmissionId];
    const submissionId = Array.isArray(submissionIdRaw)
      ? submissionIdRaw[0]
      : submissionIdRaw;

    const progreso = `[${i + 1}/${lista.length}]`;

    if (!submissionId) {
      contSinSubmission++;
      console.log(`${progreso} !  ${titulo} — SIN_SUBMISSION_ID`);
      filas.push({
        record_id: recordId,
        titulo,
        estado: 'SIN_SUBMISSION_ID',
        email_nuevo: null,
        telefono1_nuevo: null,
        telefono2_nuevo: null,
        nombre_nuevo: null,
        apellidos_nuevo: null,
        dni_nuevo: null,
        direccion_nueva: null,
        submission_id: null,
        notas: 'El registro Campus no tiene Jotform Submission ID',
      });
      continue;
    }

    try {
      const jf = await getJotformSubmission(submissionId);

      const fields = {};
      const detalles = [];

      if (!emailActual && jf.email) {
        fields[CAMPUS_FIELDS.emailContacto] = jf.email;
        detalles.push(`email=${jf.email}`);
      }

      if (tel1Actual === undefined || tel1Actual === null) {
        if (jf.telefono1) {
          const num = telefonoANumero(jf.telefono1);
          if (num !== null) {
            fields[CAMPUS_FIELDS.telefonoContacto] = num;
            detalles.push(`tel1=${num}`);
          } else {
            detalles.push(`tel1_SKIP("${jf.telefono1}" no numérico)`);
          }
        }
      }

      if (tel2Actual === undefined || tel2Actual === null) {
        if (jf.telefono2) {
          const num = telefonoANumero(jf.telefono2);
          if (num !== null) {
            fields[CAMPUS_FIELDS.telefonoContacto2] = num;
            detalles.push(`tel2=${num}`);
          } else {
            detalles.push(`tel2_SKIP("${jf.telefono2}" no numérico)`);
          }
        }
      }

      if (!f[CAMPUS_FIELDS.nombreTutor] && jf.tutorFirst) {
        fields[CAMPUS_FIELDS.nombreTutor] = jf.tutorFirst;
        detalles.push(`nombre=${jf.tutorFirst}`);
      }

      if (!f[CAMPUS_FIELDS.apellidosTutor] && jf.tutorLast) {
        fields[CAMPUS_FIELDS.apellidosTutor] = jf.tutorLast;
        detalles.push(`apellidos=${jf.tutorLast}`);
      }

      if (!f[CAMPUS_FIELDS.dniTutor] && jf.dniTutor) {
        fields[CAMPUS_FIELDS.dniTutor] = jf.dniTutor;
        detalles.push(`dni=${jf.dniTutor}`);
      }

      if (!f[CAMPUS_FIELDS.direccion] && jf.direccion) {
        fields[CAMPUS_FIELDS.direccion] = jf.direccion;
        detalles.push(`direccion=(multilinea ${jf.direccion.split('\n').length}L)`);
      }

      if (Object.keys(fields).length === 0) {
        contSinCambios++;
        console.log(`${progreso} ·  ${titulo} — SIN_CAMBIOS`);
        filas.push({
          record_id: recordId,
          titulo,
          estado: 'SIN_CAMBIOS',
          email_nuevo: null,
          telefono1_nuevo: null,
          telefono2_nuevo: null,
          nombre_nuevo: null,
          apellidos_nuevo: null,
          dni_nuevo: null,
          direccion_nueva: null,
          submission_id: submissionId,
          notas: detalles.join(' | '),
        });
      } else {
        contListos++;
        updates.push({ id: recordId, fields });
        console.log(`${progreso} +  ${titulo} — ${detalles.join(', ')}`);
        filas.push({
          record_id: recordId,
          titulo,
          estado: 'LISTO',
          email_nuevo: fields[CAMPUS_FIELDS.emailContacto] ?? null,
          telefono1_nuevo: fields[CAMPUS_FIELDS.telefonoContacto] ?? null,
          telefono2_nuevo: fields[CAMPUS_FIELDS.telefonoContacto2] ?? null,
          nombre_nuevo: fields[CAMPUS_FIELDS.nombreTutor] ?? null,
          apellidos_nuevo: fields[CAMPUS_FIELDS.apellidosTutor] ?? null,
          dni_nuevo: fields[CAMPUS_FIELDS.dniTutor] ?? null,
          direccion_nueva: fields[CAMPUS_FIELDS.direccion] ?? null,
          submission_id: submissionId,
          notas: detalles.join(' | '),
        });
      }
    } catch (err) {
      contError++;
      console.log(`${progreso} ✗  ${titulo} — ERROR_JOTFORM: ${err.message}`);
      filas.push({
        record_id: recordId,
        titulo,
        estado: 'ERROR_JOTFORM',
        email_nuevo: null,
        telefono1_nuevo: null,
        telefono2_nuevo: null,
        nombre_nuevo: null,
        apellidos_nuevo: null,
        dni_nuevo: null,
        direccion_nueva: null,
        submission_id: submissionId,
        notas: err.message,
      });
    }

    // Pausa mínima entre llamadas a Jotform
    await new Promise((r) => setTimeout(r, 100));
  }

  // Aplicación de cambios
  if (args.live && updates.length > 0) {
    console.log(
      `\n⚠  Modo LIVE. Se van a escribir ${updates.length} registros en Airtable.`
    );
    console.log('   Esperando 5 segundos... (Ctrl+C para cancelar)');
    await new Promise((r) => setTimeout(r, 5000));

    console.log('→ Enviando PATCH a Airtable (batches de 10)...');
    const actualizados = await updateCampusRecords(updates);
    console.log(`✓ ${actualizados.length} registros actualizados en Airtable.`);
  } else if (args.live) {
    console.log('\n·  Modo LIVE, pero no hay cambios que aplicar.');
  } else {
    console.log(
      `\n(DRY-RUN) ${updates.length} registros se actualizarían en modo --live.`
    );
  }

  // CSV
  mkdirSync(LOGS_DIR, { recursive: true });
  const sufijo = args.live ? 'live' : 'dryrun';
  const csvFile = join(
    LOGS_DIR,
    `backfill-emails-${sufijo}-${filenameTimestamp()}.csv`
  );

  const headers = [
    'record_id',
    'titulo',
    'estado',
    'email_nuevo',
    'telefono1_nuevo',
    'telefono2_nuevo',
    'nombre_nuevo',
    'apellidos_nuevo',
    'dni_nuevo',
    'direccion_nueva',
    'submission_id',
    'notas',
  ];
  const csvContent = [
    headers.join(','),
    ...filas.map((fila) => headers.map((h) => escaparCSV(fila[h])).join(',')),
  ].join('\n');

  writeFileSync(csvFile, '﻿' + csvContent, 'utf8');

  console.log('\n' + '='.repeat(70));
  console.log('RESUMEN');
  console.log('='.repeat(70));
  console.log(`  Modo                       : ${modo}`);
  console.log(`  Candidatos totales         : ${candidatos.length}`);
  console.log(`  Procesados                 : ${lista.length}`);
  console.log(`  +  LISTO (con cambios)     : ${contListos}`);
  console.log(`  ·  SIN_CAMBIOS             : ${contSinCambios}`);
  console.log(`  !  SIN_SUBMISSION_ID       : ${contSinSubmission}`);
  console.log(`  ⚠  ERROR_JOTFORM           : ${contError}`);
  console.log('='.repeat(70));
  console.log(`\n✓ CSV generado: ${csvFile}`);
}

main().catch((err) => {
  console.error('\n✗ Error fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
