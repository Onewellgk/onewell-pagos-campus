# Onewell Pagos Campus — Automatización

Scripts para gestión de recordatorios de pagos fraccionados del Gk Summer Camp PRO 2026.

## Paso 1 — Auditoría de emails

Cruza los 79 Campus con saldo pendiente contra sus submissions de Jotform para detectar emails faltantes o inconsistentes.

No modifica nada. Solo genera un CSV en `logs/auditoria-emails-YYYYMMDD-HHMM.csv`.

```powershell
npm run audit:emails
```

### Salida del CSV

Columnas: `record_id`, `titulo`, `estado`, `email_airtable`, `email_jotform`, `email_stripe`, `telefono_airtable`, `telefono_jotform`, `submission_id`, `notas`.

Estados posibles:

- `OK` — email en Campus y coincide con Jotform.
- `CONFLICTO` — Campus tiene email pero distinto del de Jotform. Revisar manualmente.
- `BACKFILL` — Campus vacío y Jotform tiene email → candidato a importar.
- `SIN_EMAIL_EN_JOTFORM` — ni Campus ni Jotform tienen email. Caso anómalo.
- `ERROR_JOTFORM` — no se pudo recuperar el submission de Jotform.
- `SIN_SUBMISSION_ID` — el registro Campus no tiene Submission ID.