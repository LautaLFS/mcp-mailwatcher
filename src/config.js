import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cargar .env desde la raíz del proyecto (un nivel por encima de src/)
const envPath = path.resolve(__dirname, "..", ".env");
dotenv.config({ path: envPath });

function required(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env var ${name}`);
  }
  return val;
}

// Carga config.json (prompt + slack template)
const configPath = path.resolve(__dirname, "config.json");
let extraConfig = {};
try {
  extraConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (e) {
  console.warn("Could not read config.json, using defaults");
}

export const CONFIG = {
  // Exchange / EWS (MAPI sobre HTTP)
  ews: {
    url: required("EWS_URL"),
    user: process.env.EWS_USER || required("MAIL_USER"),
    pass: process.env.EWS_PASS || required("MAIL_PASS"),
    // Opcionales: dominio y workstation para NTLM
    domain: process.env.NTLM_DOMAIN || undefined,
    workstation: process.env.NTLM_WORKSTATION || undefined
  },

  // Carpetas de correo
  mailbox: process.env.MAIL_FOLDER || "INBOX",
  processedFolder: process.env.MAIL_PROCESSED_FOLDER || "Procesados",

  // Scheduler
  pollInterval: parseInt(process.env.POLL_INTERVAL_MINUTES, 10) || 5,

  // Ollama
  ollama: {
    api: process.env.OLLAMA_API || "http://localhost:11434/api/generate",
    model: process.env.OLLAMA_MODEL || "llama3"
  },

  // Slack
  slack: {
    token: required("SLACK_TOKEN"),
    channel: process.env.SLACK_CHANNEL || "infraestructura"
  },

  // Prompt + template (override via config.json)
  prompt:
    extraConfig.prompt ||
    "Analizá el siguiente correo con información de logs o reportes de servidores. Respondé solo con la palabra 'ALERTA' si el mensaje describe un problema importante, o con 'OK' si es normal.\\n\\n---\\n{body}",
  slackTemplate:
    extraConfig.slackTemplate ||
    ":rotating_light: *Alerta detectada*\\n*Asunto:* {subject}\\n*Remitente:* {from}\\n*Resumen:* {summary}\\n*Fecha:* {date}"
};


