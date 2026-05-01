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
  // URL pública del propio servicio (donde llegan success_url/cancel_url de Stripe Checkout).
  // Opcional para no romper deploys existentes; /post-jotform devolverá 500 si falta.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || null,
  // Modo test del endpoint /post-jotform. Solo true cuando explícitamente 'true'.
  // Permite probar el flujo sin pasar por Jotform real (con submission sintética).
  enableTestMode: process.env.ENABLE_TEST_MODE === 'true',
  // Token compartido para autenticar llamadas a los endpoints /admin/*.
  // Obligatorio en producción; sin él, los endpoints admin devuelven 503.
  // Lo configura Airtable Automations en el header X-Admin-Token.
  adminApiToken: process.env.ADMIN_API_TOKEN || null,
  // Email del equipo de coordinación al que se le envía la notificación
  // cuando una familia no paga el recovery en 24h. Default: info@academy.onewellgk.com.
  recoveryNotifyEmail: (process.env.RECOVERY_NOTIFY_EMAIL || 'info@academy.onewellgk.com').trim(),
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

  // Métodos de pago por plazo (fórmulas / singleSelect) — LEGACY, se mantienen
  // para referencia histórica y para la inicialización de los campos de decisión.
  metodoPago2o3plazos: 'fldgg3oeLsF2Cglmn',
  metodoPago3r3plazos: 'fldDao4fFZygs2l5n',
  metodoPago2o2plazos: 'fldaczR0FW3XXiQ6b',

  // Métodos de pago por plazo — DECISIÓN OPERATIVA (singleSelect editable por
  // coordinadores). Son la fuente de verdad para el script 03. Valores posibles:
  // 'Tarjeta', 'Efectivo', 'Ya pagado'.
  metodoPago2oDecision: 'fldEDcen6Dr6QHTAK',
  metodoPago3rDecision: 'fldbbbWfg2Ow2UfNu',

  // Resultado del pago (lo escribe el webhook)
  pagado2oPago: 'fld0dDnqW5ViN8eTo',
  pagado3rPago: 'fldSliYAvZr7xL8OJ',
  fechaPago2oPlazo: 'fld04ITQeqlZBI4Eq',
  fechaPago3rPlazo: 'fldpdDpqmlaM1PLuU',
  pagadoTarjetaJotform: 'fldXkdAVl0E74W7kk',

  // Stripe
  stripeCustomerId: 'fldMPHtDsDSsiPMwJ',
  // PaymentMethod ID (creado en Phase 0). Solo se rellena cuando el cliente
  // autorizó setup_future_usage='off_session' (es decir, cuando la tarjeta
  // queda guardada para cobros futuros del 2º/3r plazo).
  stripePaymentMethodId: 'fldwVhfVQP2PnagE0',
  // Datos de transacción (longText). Bloque legible escrito por el webhook con
  // resumen del cobro: importe, plan, customer/PI/PM IDs, marca/last4 de tarjeta.
  datosTransaccion: 'fldMvuDNt4thhQ41M',

  // Estado de la inscripción — requisito para que el script procese cobros.
  // Valores posibles: 'Interés inicial', 'Registro - Acceso prioritario',
  // 'Inscrito', 'Baja', 'Solicitud de plaza'. El script solo procesa 'Inscrito'.
  estado: 'fldQuL5odLqkWubzL',

  // Phase 2c — flujo de recovery cuando la reserva quedó pendiente con tarjeta.
  // Estado calculado por fórmula: '✅ Pagado tarjeta' | 'Pendiente reserva efectivo'
  // | '⚠️ Pendiente reserva tarjeta' | '🆕 Sin pago — recién inscrito' | 'Otro (revisión manual)'.
  // El endpoint /admin/recovery-link-and-send solo procesa '⚠️ Pendiente reserva tarjeta'.
  estadoPagoReserva: 'fldmQUvSUzoM8eTDK',
  // URL del Stripe Payment Link generado por /admin/recovery-link-and-send.
  // Se incluye en el email enviado a la familia. Persistente: no se regenera
  // si ya tiene valor (idempotencia). Limitado a un solo cobro vía restrictions.
  paymentLinkReserva: 'fld4AAh9dcPfMh5WP',
  // Flag que el coordinador marca cuando una inscripción se gestiona manualmente
  // (WhatsApp, teléfono, link específico fuera del flujo automático). El endpoint
  // /admin/recovery-link-and-send NO procesa records con este flag activado.
  comunicacionManual: 'fldwV12up1XPWi0A6',
  // Timestamp del envío del email de recovery a la familia. Idempotencia:
  // si tiene valor, /admin/recovery-link-and-send no reenvía.
  recoveryEmailEnviadoEn: 'fldLtm9rCRvjiheJK',
  // Timestamp de la notificación al equipo de coordinación tras 24h sin pago.
  // Idempotencia: si tiene valor, /admin/notify-uri-recovery no reenvía.
  recoveryUriNotificadoEn: 'fldQAfq63qR0KNhKJ',
};

// QIDs de Jotform (confirmados contra submission real)
export const JOTFORM_QIDS = {
  // Existentes (LEGACY, usados por scripts 01/02)
  email: '31',
  telefono1: '480',
  telefono2: '481',
  nombreTutor: '199',
  dniTutor: '200',
  direccion: '380',
  stripeCheckout: '351',

  // Phase 2 — leídos por /post-jotform para decidir flujo y construir Checkout.
  nombrePortero: '3',
  metodoPagoUnico: '227',
  plazosDePago: '391',
  metodoRestanteFrac2: '457',
  metodoReserva: '458',
  metodoRestanteFrac3: '459',
  precioBase: '460',
  aCobrarAhora: '461',
  saldoPendiente: '467',
};
