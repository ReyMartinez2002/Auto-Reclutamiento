# Auto-Reclutamiento

Extensión MV3 para agilizar la captura y clasificación de candidatos en Computrabajo.

## Integración con Google Sheets

1. Despliega un endpoint (por ejemplo, un Web App de Google Apps Script) que acepte POST JSON y habilite CORS.
2. En la ventana del popup configura la URL del endpoint y, si aplica, una clave (se envía en el encabezado `X-Api-Key`).
3. Usa “Enviar rol actual” o “Enviar todos los roles” para sincronizar las filas deduplicadas y validadas.
