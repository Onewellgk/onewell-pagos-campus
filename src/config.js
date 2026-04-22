import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Variable de entorno ${name} no configurada. Revisa tu .env`);
  }
  return value;
}

export const config = {
  airtable: {
    pat: required('AIRTABLE_PAT'),
    baseId: required('AIRTABLE_BASE_ID'),
    tableCampus: required('AIRTABLE_TABLE_CAMPUS'),
  },
  jotform: {
    apiKey: required('JOTFORM_API_KEY'),
    formIdCampus2026: required('JOTFORM_FORM_ID_CAMPUS_2026'),
    baseUrl: 'https://eu-api.jotform.com',
  },
  stripe: {
    secretKey: required('STRIPE_SECRET_KEY'),
    // STRIPE_WEBHOOK_SECRET se añade al .env después de lanzar `stripe listen`.
    // Lo hacemos opcional aquí; el script 04 hará su propio check al arrancar.
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
  },
  email: {
    resendApiKey: required('RESEND_API_KEY'),
    from: required('EMAIL_FROM').trim(),
    fromName: (process.env.EMAIL_FROM_NAME || 'Onewell Gk Academy').trim(),
  },
  webhook: {
    port: parseInt(process.env.WEBHOOK_PORT || '3000', 10),
  },
  dryRun: process.env.DRY_RUN !== 'false',
  logLevel: process.env.LOG_LEVEL || 'info',
};

// IDs de campos Airtable (Campus) — hardcoded porque son estables
export const CAMPUS_FIELDS = {
  // Identidad / contacto
  titulo: 'fld7j6uroep2PTW2A',
  emailContacto: 'flduAvxNHXTq2eXG4',
  telefonoContacto: 'fld2Nryc6JIZ0ObQi',
  telefonoContacto2: 'fldxZNewA7ApX5Vsq',
  nombreTutor: 'fldrKjZNurWGbbf4X',
  apellidosTutor: 'fldjtuAhom3agx8a0',
  dniTutor: 'fldbe0qosLjxXNYhu',
  direccion: 'fldUdnjp8YzV3D2GY',
  nombrePortero: 'fldpPOOz82pxfU2nF',
  apellidosPortero: 'fldaENd2SXGll4IFD',

  // Jotform / saldo
  jotformSubmissionId: 'fldGlcP9UT7LFDOOP',
  saldoPendiente: 'fldQK6w8IxJ2iPWZ8',
  stripeTransactionId: 'fldfYq02w357vBW17',
  metodoPagoReserva: 'fldUtyIDQH678HgqX',

  // Plazo próximo (fórmulas)
  fechaProximoPlazo: 'fldjwic7maihkzaTZ',
  plazoProximo: 'fldIN7bGvD0esy535',
  importeProximoPlazo: 'fldzhhZzkFWrmVjRx',
  plazosDePago: 'fldHQUBw5wlsQXbRn',

  // Estado del recordatorio / link
  recordatorioEnviadoEn: 'fldGP6oYSBBm2lh2l',
  paymentLinkProximoPlazo: 'fldVysmMAHPBEMhNO',
  alertaCoordinadorEnviadaEn: 'fldKEU2P5v2q8TNlq',

  // Métodos de pago por plazo (fórmulas / singleSelect)
  metodoPago2o3plazos: 'fldgg3oeLsF2Cglmn',
  metodoPago3r3plazos: 'fldDao4fFZygs2l5n',
  metodoPago2o2plazos: 'fldaczR0FW3XXiQ6b',

  // Resultado del pago (lo escribe el webhook)
  pagado2oPago: 'fld0dDnqW5ViN8eTo',
  pagado3rPago: 'fldSliYAvZr7xL8OJ',
  fechaPago2oPlazo: 'fld04ITQeqlZBI4Eq',
  fechaPago3rPlazo: 'fldpdDpqmlaM1PLuU',

  // Stripe
  stripeCustomerId: 'fldMPHtDsDSsiPMwJ',
};

// QIDs de Jotform (confirmados contra submission real)
export const JOTFORM_QIDS = {
  email: '31',
  telefono1: '480',
  telefono2: '481',
  nombreTutor: '199',
  dniTutor: '200',
  direccion: '380',
  stripeCheckout: '351',
};