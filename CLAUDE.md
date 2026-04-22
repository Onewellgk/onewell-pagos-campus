# Onewell Pagos Campus — Contexto del proyecto

Sistema de automatización para los pagos fraccionados del Gk Summer Camp PRO 2026 de Onewell GK Academy.

## Estado actual

- **Paso 1 completado**: auditoría de emails. Script `scripts/01-audit-emails.js` ejecutado. Resultado: 27 OK, 52 BACKFILL, 0 conflictos, 0 errores. CSV en `logs/`.
- **Paso 2 cerrado con backfill ampliado (2026-04-22)**: script `scripts/02-backfill-emails.js` ejecutado en varias tandas `--live`. Total: 52/52 registros actualizados con email, teléfonos 1/2, nombre y apellidos del tutor, DNI y dirección; 27 registros quedaron como SIN_CAMBIOS (ya completos); 0 errores en todas las tandas. CSVs en `logs/backfill-emails-live-*.csv`.
- **Paso 3 en progreso / validado en test con registro ficticio (2026-04-22)**: scripts `03-send-payment-links.js` (crea Customer+Product+Price+Payment Link en Stripe, email vía Resend, marca Airtable) y `04-webhook-stripe.js` (Express en 3000, verifica firma, idempotente con matiz de rellenar fecha si importe ya estaba). Ciclo end-to-end probado con `rec2FbM1bJWe7pTH6`: script 03 → email recibido → pago con `4242 4242 4242 4242` → `checkout.session.completed` forwarded por `stripe listen` → webhook actualiza Airtable (`Pagado 2o pago = 322.5`, `Fecha pago 2o plazo = 2026-04-22`). Pendiente: verificar dominio `academy.onewellgk.com` en Resend, desplegar webhook en VPS Hostinger, configurar cron 08:00 para script 03.

## Decisiones ya tomadas (no revisar, solo aplicar)

- Email fuente de verdad: el que el tutor puso en Jotform (QID 31), NO el de Familia/Contactos.
- Teléfonos Airtable son tipo `number`. Opción (a) elegida: escribir tal cual viene de Jotform, convirtiendo el string a número (limpiar espacios, paréntesis y guiones; si hay `+`, eliminarlo). Si no es numérico puro, no escribir ese campo.
- Incluir también `Teléfono de contacto 2` (QID 481) si existe en Jotform.
- Backfill ampliado (2026-04-22): además de email y teléfonos, el script 02 escribe nombre, apellidos y DNI del tutor (QID 199 .first/.last y QID 200) y dirección (QID 380, formateada en multilinea estructurada). Filtro del script ampliado a "saldo > 0" sin filtro por email — la lógica por-campo "no sobrescribir si ya tiene valor" mantiene la seguridad.
- Ejecución del backfill: primero 5 en live, verificación manual en Airtable, luego los 47 restantes.
- Arquitectura para siguientes pasos: scripts Node.js en cron en VPS Hostinger (no N8N, no Make).
- Payment Links de Stripe se generan en cada plazo (no cobro off-session).
- Recordatorios pre-deadline al cliente: 10 días antes.
- Alertas post-deadline al coordinador: 5 días después, vía tareas en Notion (base ya creada).

## Stack técnico

- Node.js v24
- Airtable base: `appsfW2BLNkt8z8cl`, tabla Campus: `tblYuQzz5jbkWaeXs`
- Jotform EU API (`https://eu-api.jotform.com`), form Campus 2026: `260351137337351`
- Notion database alertas: `dd3d0f07-f65b-4f69-bff7-30b7bd7ee043`
- Stripe (test mode), Payment Links; webhook en Express (puerto 3000).
- Email: **Resend** (SDK `resend`). En sandbox el `from` es `onboarding@resend.dev` y solo envía a la cuenta dueña del API key (actualmente `gerardnf1@gmail.com`); cualquier otra dirección rebota hasta verificar el dominio `academy.onewellgk.com`.
- Credenciales en `.env` (no commitear — ya está en `.gitignore`)

## Campos Airtable Campus relevantes

- `fld7j6uroep2PTW2A` — Título
- `flduAvxNHXTq2eXG4` — Correo electrónico de contacto (email tipo email)
- `fld2Nryc6JIZ0ObQi` — Teléfono de contacto (tipo number)
- `fldxZNewA7ApX5Vsq` — Teléfono de contacto 2 (tipo number)
- `fldrKjZNurWGbbf4X` — Nombre del padre, madre o tutor/a (singleLineText)
- `fldjtuAhom3agx8a0` — Apellidos del padre, madre o tutor/a (singleLineText)
- `fldbe0qosLjxXNYhu` — DNI del padre, madre o tutor/a (singleLineText)
- `fldUdnjp8YzV3D2GY` — Dirección (multilineText)
- `fldGlcP9UT7LFDOOP` — Jotform Submission ID
- `fldQK6w8IxJ2iPWZ8` — Total saldo pendiente (calculado)
- `fldfYq02w357vBW17` — Stripe Transaction ID
- `fldUtyIDQH678HgqX` — Método de pago reserva (150€)
- `fldGP6oYSBBm2lh2l` — Recordatorio próximo plazo enviado en (dateTime)
- `fldVysmMAHPBEMhNO` — Payment Link próximo plazo (url)
- `fldKEU2P5v2q8TNlq` — Alerta coordinador post-deadline enviada en (dateTime)
- `fldjwic7maihkzaTZ` — Fecha próximo plazo (fórmula)

## QIDs Jotform Campus 2026

- `31` — Correo electrónico del tutor (answer = string directo)
- `480` — Teléfono 1 (answer = string)
- `481` — Teléfono 2 (answer = string)
- `199` — Nombre tutor. `answer.first` y `answer.last` se extraen por separado hacia los campos Airtable Nombre y Apellidos. Se mantiene además `nombreTutor` concatenado en el output de `parseAnswers` por compatibilidad.
- `200` — DNI tutor (answer = string directo)
- `380` — Dirección. `answer` es un objeto `{ addr_line1, addr_line2, city, state, postal, country }`. Se formatea en multilínea (línea 1: dirección; línea 2: `postal city, state`; línea 3: país) antes de escribir.
- `351` — Stripe Checkout (answer.paymentArray contiene JSON con email y transaction ID)

## Convenciones del repo

- Todos los scripts tienen modo DRY-RUN por defecto.
- Modo live solo con flag `--live` explícito.
- Flag `--limit N` para procesar subconjunto.
- Logs en `logs/` con timestamp `YYYYMMDD-HHMM`.
- CSVs con BOM UTF-8 para Excel.
- Pausa de 100 ms entre llamadas a Jotform para no saturar la API.
- Airtable PATCH en batches de 10 registros máximo (límite API).

## Siguientes pasos

### Paso 2 — Backfill (inmediato)

Crear `scripts/02-backfill-emails.js` y añadir al `package.json`:

```json
"backfill:emails": "node scripts/02-backfill-emails.js"
```

Lógica:
1. Reutiliza `src/airtable.js` y `src/jotform.js` existentes.
2. Añade a `src/airtable.js` una función `updateCampusRecords(updates)` que haga PATCH batch de máximo 10 registros.
3. El script 02 lista registros con saldo > 0 Y email vacío en Airtable.
4. Para cada uno, llama Jotform, extrae email, teléfono 1 y teléfono 2.
5. Escribe en Airtable solo los campos que en Campus estén vacíos (no sobrescribe si el coordinador ya puso algo).
6. Genera CSV de resultados en `logs/`.
7. Soporta flags `--live` y `--limit N`.
8. En modo LIVE, esperar 5 segundos antes de escribir para dar ventana de cancelación con Ctrl+C.

Ejecución recomendada:
1. `npm run backfill:emails -- --limit 5` (dry-run de 5)
2. `npm run backfill:emails -- --live --limit 5` (live de 5)
3. Verificación manual en Airtable
4. `npm run backfill:emails -- --live` (los 47 restantes)

### Paso 3 — Generación de Payment Links Stripe (después del Paso 2)

Pendiente de diseño. Stripe test mode, webhook en VPS Hostinger, plantilla email redactada.

### Paso 4 — Webhook Stripe (servidor permanente)

Pendiente de diseño.