import { WebClient } from "@slack/web-api";
import { CONFIG } from "./config.js";
import logger from "./utils/logger.js";

const slack = new WebClient(CONFIG.slack.token);

/**
 * Envía una notificación a Slack usando el template configurable.
 *
 * Campos esperados:
 *  - subject: asunto del correo
 *  - from: dirección del remitente
 *  - date: fecha en ISO o formato legible
 *  - summary: resumen corto del contenido (por ejemplo primeros 300 chars)
 */
export async function sendSlackAlert({ subject, from, date, summary }) {
  const template = CONFIG.slackTemplate;
  const text = template
    .replace("{subject}", subject || "(sin asunto)")
    .replace("{from}", from || "(desconocido)")
    .replace("{date}", date || new Date().toISOString())
    .replace("{summary}", summary || "(sin resumen)");

  try {
    await slack.chat.postMessage({
      channel: CONFIG.slack.channel,
      text,
      mrkdwn: true
    });
    logger.info(`✅ Alerta enviada a Slack para "${subject}"`);
  } catch (err) {
    logger.error(`❌ Falló el envío de la notificación a Slack: ${err.message}`);
    // No relanzamos el error para no interrumpir el ciclo:
    // el problema queda registrado en logs y se puede revisar el token/config.
  }
}


