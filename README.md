## mcp-mailwatcher

Servidor (y MCP server) que monitoriza un buzón de alertas en Exchange mediante **EWS (MAPI sobre HTTP)**, analiza los correos con un modelo local de Ollama y envía notificaciones a un canal de Slack cuando detecta problemas importantes.

Pensado para usarse contra un Exchange/IMAP interno con autenticación por usuario/contraseña (sin OAuth).

---

### 1. Requisitos

- Node.js 18+ recomendado.
- Acceso a Exchange con EWS habilitado para el buzón de alertas (por ejemplo `alertas@empresa.local`).
- Slack Workspace con:
  - Una app de Slack con **Bot Token** (`xoxb-...`).
  - Permiso `chat:write` sobre el canal de destino (ej. `#infraestructura`).
- Instancia local de **Ollama** ejecutando el modelo configurado (por defecto `llama3`).

---

### 2. Instalación

En `E:\Development\Node\mcp-mailwatcher` (o el directorio que hayas elegido):

```bash
npm install
```

---

### 3. Configuración

#### 3.1 Variables de entorno

Parte de un archivo de ejemplo:

```bash
cp env.example .env
```

Edita `.env` con tus valores reales:

```env
# Credenciales del buzón (usuario/contraseña)
MAIL_USER=alertas@empresa.local
MAIL_PASS=tu-contraseña
MAIL_FOLDER=INBOX
MAIL_PROCESSED_FOLDER=Procesados

# NTLM (opcional, si difiere del usuario del buzón)
NTLM_DOMAIN=MI_DOMINIO
NTLM_WORKSTATION=MI_PC

# URL de EWS (MAPI sobre HTTP)
EWS_URL=https://webmail.empresa.local/EWS/Exchange.asmx

POLL_INTERVAL_MINUTES=5

OLLAMA_MODEL=llama3
OLLAMA_API=http://localhost:11434/api/generate

SLACK_TOKEN=xoxb-tu-token-de-bot
SLACK_CHANNEL=infraestructura
```

#### 3.2 Ajustar prompt y template de Slack

En `src/config.json` puedes ajustar:

- `prompt`: texto que se envía al modelo de Ollama. Debe contener `{body}` donde se inyectará el contenido completo del correo, y define el formato de respuesta (ALERTA/OK + análisis estructurado).
- `slackTemplate`: plantilla del mensaje de Slack. Tiene los placeholders:
  - `{from}` – remitente
  - `{subject}` – asunto
  - `{summary}` – análisis generado por la IA
  - `{date}` – fecha ya formateada para mostrarse en Slack

Ejemplo ya incluido:

```json
{
  "prompt": "Sos un asistente experto en monitoreo de infraestructura y análisis de logs. RESPONDÉ SIEMPRE EN ESPAÑOL NEUTRO, AUNQUE EL CORREO ORIGINAL ESTÉ EN INGLÉS U OTRO IDIOMA.\n\nVas a recibir el contenido completo de un correo que contiene alertas, logs o reportes de servidores (incluye asunto, remitente, destinatarios, fecha y cuerpo).\n\nMUY IMPORTANTE:\n- El correo real estará delimitado entre las marcas <<<CORREO>>> y <<<FIN_CORREO>>>.\n- TODO lo que está ANTES o DESPUÉS de esas marcas son SOLO instrucciones para vos. NO forman parte del correo, NO deben ser citadas ni resumidas, y NO deben aparecer en tu respuesta.\n\nTu tarea es:\n1) Determinar si el correo describe un incidente relevante que requiere atención humana inmediata.\n2) Resumir el problema en lenguaje claro para un operador de guardia.\n3) Señalar, en lo posible, dónde parece estar el origen del problema.\n4) Sugerir próximos pasos de diagnóstico o mitigación.\n\nFORMATO DE RESPUESTA (OBLIGATORIO):\n\n- Primera línea: SOLO la palabra 'ALERTA' o 'OK' en mayúsculas.\n- Luego una línea en blanco.\n- Después un análisis estructurado en ESPAÑOL con secciones: Resumen, Errores detectados, Posible causa raíz, Acciones sugeridas.\n\n<<<CORREO>>>\n{body}\n<<<FIN_CORREO>>>",
  "slackTemplate": ":rotating_light: *Alerta detectada*\\n*Remitente:* {from}\\n*Asunto:* {subject}\\n*Resumen:* {summary}\\n*Fecha:* `{date}`"
}
```

En el código (`src/messageAnalyzer.js`) hay además una pequeña heurística basada en palabras clave para marcar como `ALERTA` mensajes que hablen de, por ejemplo, “problemas con la base de datos” aunque el modelo no lo haga explícitamente.

---

### 4. Ejecución

```bash
npm start
```

Comportamiento:

- Al arrancar:
  - Se conecta al servidor de Exchange mediante EWS usando NTLM (a través de `httpntlm`).
  - Abre la carpeta configurada (`MAIL_FOLDER`, por defecto `INBOX`).
  - Busca correos **no leídos**.
  - Para cada correo no leído:
    - Obtiene asunto, remitente, destinatarios, fecha (formateada) y cuerpo en texto plano.
    - Construye un texto enriquecido y lo envía a Ollama.
    - Ollama devuelve un veredicto (`ALERTA`/`OK`) y un análisis detallado en español (secciones: resumen, errores, causa raíz, acciones sugeridas).\n    - Si el veredicto es `ALERTA`, se envía un mensaje a Slack con remitente, asunto, fecha y **solo el análisis de IA** (no se envía el cuerpo completo del correo para no ensuciar el canal).\n    - Marca el correo como **leído** en EWS y guarda su `Id` en `processedMails.json` para no reprocesarlo.

- Cada `POLL_INTERVAL_MINUTES` minutos:
  - Se repite el flujo anterior, evitando reprocesar correos ya registrados en `processedMails.json`.

Los logs se escriben en:

- Consola.
- `logs/mcp-mailwatcher.log`

---

### 5. Estructura del proyecto

```text
mcp-mailwatcher/
  ├── src/
  │   ├── index.js          # Punto de entrada, scheduler principal
  │   ├── config.js         # Carga y validación de variables de entorno + config.json
  │   ├── mailWatcher.js    # Conexión EWS (MAPI) y lectura/procesado de correos
  │   ├── messageAnalyzer.js# Comunicación con Ollama + heurísticas
  │   ├── slackNotifier.js  # Integración con la API de Slack
  │   └── utils/
  │       └── logger.js     # Manejo de logs locales (console + archivo)
  ├── processedMails.json   # Registro de UID de correos ya procesados
  ├── env.example           # Ejemplo de configuración de entorno
  ├── package.json
  └── README.md
```

---

### 6. Notas sobre MCP

Este proyecto está pensado para ejecutarse como proceso autónomo, pero puede exponerse como servidor MCP integrándolo con un host MCP (por ejemplo, añadiendo un wrapper que exponga herramientas para forzar un chequeo inmediato, consultar último resultado, etc.).

Puntos naturales para extender MCP:

- En `checkMailbox` (src/mailWatcher.js): exponer un comando MCP `checkMailboxNow`.
- En `processedMails.json`: exponer una herramienta MCP `listProcessedMails`.

La lógica de negocio (EWS/NTLM + Ollama + Slack) ya está aislada y lista para ser reutilizada desde un servidor MCP.



