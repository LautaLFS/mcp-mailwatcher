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

# URL de EWS (MAPI sobre HTTP)
EWS_URL=https://mail.interno.local/EWS/Exchange.asmx

POLL_INTERVAL_MINUTES=5

OLLAMA_MODEL=llama3
OLLAMA_API=http://localhost:11434/api/generate

SLACK_TOKEN=xoxb-tu-token-de-bot
SLACK_CHANNEL=infraestructura
```

#### 3.2 Ajustar prompt y template de Slack

En `src/config.json` puedes ajustar:

- `prompt`: texto que se envía al modelo de Ollama. Debe contener `{body}` donde se inyectará el cuerpo del correo.
- `slackTemplate`: plantilla del mensaje de Slack. Tiene los placeholders:
  - `{subject}` – asunto
  - `{from}` – remitente
  - `{summary}` – resumen corto del cuerpo
  - `{date}` – fecha

Ejemplo ya incluido:

```json
{
  "prompt": "Analizá el siguiente correo con información de logs o reportes de servidores. Respondé solo con la palabra 'ALERTA' si el mensaje describe un problema importante, o con 'OK' si es normal.\n\n---\n{body}",
  "slackTemplate": ":rotating_light: *Alerta detectada en servidor*\\n*Asunto:* {subject}\\n*Remitente:* {from}\\n*Resumen:* {summary}\\n*Fecha:* {date}"
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
  - Se conecta al servidor de Exchange mediante EWS.
  - Abre la carpeta configurada (`MAIL_FOLDER`, por defecto `INBOX`).
  - Busca correos **no leídos**.
  - Analiza cada correo con Ollama.
  - Si corresponde, envía alerta a Slack.
  - Marca los correos procesados como **leídos** y guarda sus UID en `processedMails.json`.

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

La lógica de negocio (IMAP + Ollama + Slack) ya está aislada y lista para ser reutilizada desde un servidor MCP.


