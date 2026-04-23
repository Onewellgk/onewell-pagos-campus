import { config, CAMPUS_FIELDS } from './config.js';

const BASE_URL = 'https://api.airtable.com/v0';

/**
 * Lista todos los registros Campus con saldo pendiente > 0.
 * Paginado automáticamente. Devuelve array completo.
 */
export async function listCampusConSaldoPendiente() {
  const fieldsToFetch = [
    CAMPUS_FIELDS.titulo,
    CAMPUS_FIELDS.emailContacto,
    CAMPUS_FIELDS.telefonoContacto,
    CAMPUS_FIELDS.telefonoContacto2,
    CAMPUS_FIELDS.nombreTutor,
    CAMPUS_FIELDS.apellidosTutor,
    CAMPUS_FIELDS.dniTutor,
    CAMPUS_FIELDS.direccion,
    CAMPUS_FIELDS.jotformSubmissionId,
    CAMPUS_FIELDS.saldoPendiente,
    CAMPUS_FIELDS.stripeTransactionId,
    CAMPUS_FIELDS.metodoPagoReserva,
  ];

  // filterByFormula: saldo > 0
  const filter = encodeURIComponent(`{${CAMPUS_FIELDS.saldoPendiente}}>0`);
  const fieldsParam = fieldsToFetch.map((f) => `fields%5B%5D=${f}`).join('&');

  const allRecords = [];
  let offset = null;

  do {
    const offsetParam = offset ? `&offset=${offset}` : '';
    const url = `${BASE_URL}/${config.airtable.baseId}/${config.airtable.tableCampus}?filterByFormula=${filter}&${fieldsParam}&returnFieldsByFieldId=true&pageSize=100${offsetParam}`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.airtable.pat}`,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable API ${res.status}: ${body}`);
    }

    const data = await res.json();
    allRecords.push(...data.records);
    offset = data.offset || null;
  } while (offset);

  return allRecords;
}

/**
 * Actualiza registros Campus por PATCH.
 * `updates` = array de { id, fields }, donde `fields` usa IDs de campo.
 * Parte en batches de 10 (límite de la API de Airtable).
 * Devuelve todos los registros devueltos por la API (agregados).
 */
export async function updateCampusRecords(updates) {
  if (!Array.isArray(updates) || updates.length === 0) return [];

  const url = `${BASE_URL}/${config.airtable.baseId}/${config.airtable.tableCampus}`;
  const results = [];

  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);

    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${config.airtable.pat}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        records: batch,
        returnFieldsByFieldId: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable PATCH ${res.status}: ${body}`);
    }

    const data = await res.json();
    results.push(...data.records);
  }

  return results;
}

/**
 * GET de un único registro Campus por record ID.
 * Devuelve el registro completo (con todos los campos por field ID).
 */
export async function getCampusRecord(recordId) {
  const url = `${BASE_URL}/${config.airtable.baseId}/${config.airtable.tableCampus}/${recordId}?returnFieldsByFieldId=true`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.airtable.pat}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable GET ${res.status}: ${body}`);
  }

  return res.json();
}

/**
 * PATCH de un único registro Campus. `fields` usa IDs de campo.
 * Pensado para escrituras parciales (ej. webhook, script 03 paso a paso).
 */
export async function updateCampusRecord(recordId, fields) {
  const url = `${BASE_URL}/${config.airtable.baseId}/${config.airtable.tableCampus}/${recordId}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${config.airtable.pat}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields, returnFieldsByFieldId: true }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable PATCH (single) ${res.status}: ${body}`);
  }

  return res.json();
}

/**
 * Lista candidatos Campus para recordatorio de Payment Link.
 * Filtro: saldo > 0, recordatorio aún no enviado, plazo próximo no en blanco,
 * importe próximo plazo > 0, y Fecha próximo plazo = HOY + N días (timezone Madrid).
 *
 * El chequeo "método de plazo es Tarjeta" se hace en el script 03 a partir
 * de los tres campos de método (2o-3plazos, 2o-2plazos, 3r-3plazos), porque
 * la columna relevante depende del plazo actual del registro.
 */
export async function listCampusCandidatosPaymentLink({ diasDesdeHoy = 10 } = {}) {
  const fieldsToFetch = allFieldsToFetchParaPaymentLink();
  const fieldsParam = fieldsToFetch.map((f) => `fields%5B%5D=${f}`).join('&');

  // Si diasDesdeHoy es null, no filtramos por fecha: procesamos todos los candidatos
  // con plazo próximo + importe > 0 + recordatorio aún no enviado. Útil para ejecutar
  // bajo demanda fuera de la ventana estricta T-10.
  const filtroFecha = diasDesdeHoy === null
    ? ''
    : `,IS_SAME({${CAMPUS_FIELDS.fechaProximoPlazo}}, '${fechaEnMadridConOffset(diasDesdeHoy)}', 'day')`;

  const formula = `AND(
    {${CAMPUS_FIELDS.saldoPendiente}}>0,
    {${CAMPUS_FIELDS.plazoProximo}}!='',
    {${CAMPUS_FIELDS.importeProximoPlazo}}>0,
    {${CAMPUS_FIELDS.recordatorioEnviadoEn}}=''${filtroFecha}
  )`.replace(/\s+/g, ' ');

  const filter = encodeURIComponent(formula);

  const allRecords = [];
  let offset = null;

  do {
    const offsetParam = offset ? `&offset=${offset}` : '';
    const url = `${BASE_URL}/${config.airtable.baseId}/${config.airtable.tableCampus}?filterByFormula=${filter}&${fieldsParam}&returnFieldsByFieldId=true&pageSize=100${offsetParam}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.airtable.pat}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable list candidatos ${res.status}: ${body}`);
    }

    const data = await res.json();
    allRecords.push(...data.records);
    offset = data.offset || null;
  } while (offset);

  return allRecords;
}

/**
 * Lista de field IDs que el script 03 necesita leer para evaluar y poblar un registro.
 * Se expone para poder reutilizarla desde `getCampusRecord` (filtrado manual) si
 * hace falta, pero Airtable no permite `fields[]` en el GET de single record,
 * así que ese endpoint devuelve todos los campos por defecto.
 */
function allFieldsToFetchParaPaymentLink() {
  return [
    CAMPUS_FIELDS.titulo,
    CAMPUS_FIELDS.emailContacto,
    CAMPUS_FIELDS.telefonoContacto,
    CAMPUS_FIELDS.nombreTutor,
    CAMPUS_FIELDS.apellidosTutor,
    CAMPUS_FIELDS.nombrePortero,
    CAMPUS_FIELDS.apellidosPortero,
    CAMPUS_FIELDS.fechaProximoPlazo,
    CAMPUS_FIELDS.plazoProximo,
    CAMPUS_FIELDS.importeProximoPlazo,
    CAMPUS_FIELDS.plazosDePago,
    CAMPUS_FIELDS.recordatorioEnviadoEn,
    CAMPUS_FIELDS.paymentLinkProximoPlazo,
    CAMPUS_FIELDS.metodoPago2o3plazos,
    CAMPUS_FIELDS.metodoPago3r3plazos,
    CAMPUS_FIELDS.metodoPago2o2plazos,
    CAMPUS_FIELDS.metodoPago2oDecision,
    CAMPUS_FIELDS.metodoPago3rDecision,
    CAMPUS_FIELDS.estado,
    CAMPUS_FIELDS.pagado2oPago,
    CAMPUS_FIELDS.pagado3rPago,
    CAMPUS_FIELDS.stripeCustomerId,
    CAMPUS_FIELDS.saldoPendiente,
  ];
}

/**
 * Formatea la fecha en Europe/Madrid con offset en días como 'YYYY-MM-DD'.
 * Se usa para construir filtros Airtable que hablen en la zona horaria
 * del negocio (no en UTC del servidor).
 */
function fechaEnMadridConOffset(dias) {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + dias);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(base);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}