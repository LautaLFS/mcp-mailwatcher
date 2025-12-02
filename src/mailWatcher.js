import * as ews from "ews-javascript-api";
import { CONFIG } from "./config.js";
import logger from "./utils/logger.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyseMessage } from "./messageAnalyzer.js";
import { sendSlackAlert } from "./slackNotifier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const processedPath = path.resolve(__dirname, "..", "processedMails.json");

// Load/initialize processed UID list
let processedUids = new Set();
if (fs.existsSync(processedPath)) {
  try {
    const raw = JSON.parse(fs.readFileSync(processedPath, "utf8"));
    processedUids = new Set(raw);
  } catch (e) {
    logger.warn("Could not parse processedMails.json, starting fresh");
  }
}

/** Persiste los UID procesados en disco */
function persistProcessed() {
  fs.writeFileSync(
    processedPath,
    JSON.stringify(Array.from(processedUids), null, 2)
  );
}

function createEwsService() {
  const service = new ews.ExchangeService(ews.ExchangeVersion.Exchange2013);
  service.Credentials = new ews.ExchangeCredentials(
    CONFIG.ews.user,
    CONFIG.ews.pass
  );
  service.Url = new ews.Uri(CONFIG.ews.url);
  return service;
}

/**
 * Tarea principal: se ejecuta en cada ciclo del scheduler.
 *
 * - Se conecta al servidor EWS (MAPI sobre HTTP).
 * - Busca correos NO LEÍDOS en la carpeta configurada.
 * - Para cada correo:
 *    - extrae asunto, remitente, fecha y cuerpo en texto.
 *    - analiza el cuerpo con Ollama (analyseMessage).
 *    - si el resultado es ALERTA, envía mensaje a Slack.
 *    - marca el mensaje como leído y lo registra en processedMails.json.
 */
export async function checkMailbox() {
  const service = createEwsService();

  try {
    logger.info("🔐 Connected to EWS server");

    const inbox = await ews.Folder.Bind(
      service,
      ews.WellKnownFolderName.Inbox
    );

    // Recuperamos un número razonable de correos recientes.
    const view = new ews.ItemView(50);
    view.Traversal = ews.ItemTraversal.Shallow;

    const results = await service.FindItems(inbox.Id, view);
    logger.info(`📬 Found ${results.Items.length} item(s) in Inbox`);

    // Cargar propiedades completas (incluyendo cuerpo) para todos los items encontrados.
    const propertySet = new ews.PropertySet(
      ews.BasePropertySet.FirstClassProperties
    );
    propertySet.RequestedBodyType = ews.BodyType.Text;
    await service.LoadPropertiesForItems(results.Items, propertySet);

    for (const item of results.Items) {
      // Sólo correos no leídos
      if (item.IsRead) {
        continue;
      }

      const uid = item.Id?.UniqueId;
      if (uid && processedUids.has(uid)) {
        // Ya procesado en una ejecución anterior
        continue;
      }

      const subject = item.Subject;
      const fromAddress = item.From?.Address || "unknown";
      const toAddress = item.DisplayTo || "unknown";
      const date = item.DateTimeReceived || item.DateTimeCreated || new Date();
      const dateStr =
        typeof date.toISOString === "function"
          ? date.toISOString()
          : new Date(date).toISOString();

      const plainBody = item.Body?.Text || "";

      logger.info(
        `🗒️ Analizando mensaje ${uid ?? "(sin UID)"} – "${subject}" from ${fromAddress} to ${toAddress}`
      );

      // Armamos un texto enriquecido para el modelo (incluye asunto/remitente)
      const contentForAnalysis = `Asunto: ${subject ?? ""}\nRemitente: ${fromAddress}\nPara: ${toAddress}\nFecha: ${dateStr}\n\n${plainBody}`;

      // ---- LLM analysis ----
      let llmAnswer;
      try {
        llmAnswer = await analyseMessage(contentForAnalysis);
      } catch (e) {
        logger.error(
          `⚠️ LLM failed for message ${uid ?? "(sin UID)"}: ${e.message}`
        );
        continue; // se intentará de nuevo en el próximo poll
      }

      logger.info(
        `🤖 Ollama result for message ${uid ?? "(sin UID)"}: "${llmAnswer}"`
      );

      // ---- If ALERTA → Slack ----
      if (llmAnswer.includes("ALERTA")) {
        await sendSlackAlert({
          subject,
          from: fromAddress,
          date: dateStr,
          summary:
            plainBody.slice(0, 300) + (plainBody.length > 300 ? "…" : "")
        });
        logger.info(`🚨 ALERTA enviada a Slack para mensaje ${uid}`);
      } else {
        logger.info(
          `✅ Mensaje ${uid ?? "(sin UID)"} considerado OK por el analizador`
        );
      }

      // Marcar como leído para no reprocesar en el futuro
      item.IsRead = true;
      await item.Update(ews.ConflictResolutionMode.AutoResolve);
      logger.info(`📖 Mensaje ${uid ?? "(sin UID)"} marcado como leído`);

      // Registrar como procesado
      if (uid) {
        processedUids.add(uid);
        persistProcessed();
      }
    }
  } catch (err) {
    logger.error(`❌ EWS error: ${err.message}`);
  }
}


