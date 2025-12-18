import { CONFIG } from "./config.js";
import logger from "./utils/logger.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyseMessage } from "./messageAnalyzer.js";
import { sendSlackAlert } from "./slackNotifier.js";
import httpntlm from "httpntlm";
import { parseStringPromise } from "xml2js";

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

async function callEwsSoap(xmlBody) {
  const url = CONFIG.ews.url;
  const { user, pass, domain, workstation } = CONFIG.ews;

  logger.info(
    `🔑 Configuración EWS NTLM – usuario=${user} dominio=${domain ?? "N/A"} workstation=${workstation ?? "N/A"}`
  );

  return new Promise((resolve, reject) => {
    httpntlm.post(
      {
        url,
        username: user,
        password: pass,
        domain: domain || "",
        workstation: workstation || "",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          Accept: "text/xml",
          "User-Agent": "NodeNTLMClient"
        },
        body: xmlBody,
        // TLS estricto: el certificado del servidor debe ser válido
        // para el host de CONFIG.ews.url.
        strictSSL: true
      },
      (err, res) => {
        if (err) {
          return reject(err);
        }
        if (res.statusCode !== 200) {
          return reject(
            new Error(
              `EWS HTTP ${res.statusCode} ${res.statusMessage || ""}`.trim()
            )
          );
        }
        resolve(res.body);
      }
    );
  });
}

async function parseSoap(xml) {
  return parseStringPromise(xml, {
    explicitArray: false,
    ignoreAttrs: false,
    tagNameProcessors: [
      // normalizamos nombres de tags quitando prefijos tipo "t:" o "m:"
      (name) => name.replace(/^[a-zA-Z0-9]+:/, "")
    ]
  });
}

function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node._ === "string") return node._;
  return "";
}

function formatDateForDisplay(date) {
  const d =
    typeof date === "string"
      ? new Date(date)
      : date instanceof Date
        ? date
        : new Date(date);

  if (!d || Number.isNaN(d.getTime())) {
    return "";
  }

  const pad = (n) => String(n).padStart(2, "0");
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());

  // Formato: DD/MM/YYYY HH:mm:ss (hora local del servidor)
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

async function findUnreadMessages() {
  const folderId = (CONFIG.mailbox || "INBOX").toLowerCase();

  const findItemSoap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2010"/>
  </soap:Header>
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="message:From"/>
          <t:FieldURI FieldURI="message:IsRead"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="20" Offset="0" BasePoint="Beginning"/>
      <m:Restriction>
        <t:IsEqualTo>
          <t:FieldURI FieldURI="message:IsRead"/>
          <t:FieldURIOrConstant>
            <t:Constant Value="false"/>
          </t:FieldURIOrConstant>
        </t:IsEqualTo>
      </m:Restriction>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="${folderId}"/>
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>`;

  const raw = await callEwsSoap(findItemSoap);
  const parsed = await parseSoap(raw);

  const root =
    parsed?.Envelope?.Body?.FindItemResponse?.ResponseMessages
      ?.FindItemResponseMessage;

  if (!root) {
    logger.warn(
      "No se encontró FindItemResponseMessage en la respuesta de EWS"
    );
    return [];
  }

  const messagesContainer = root.RootFolder?.Items;
  if (!messagesContainer) {
    logger.info(
      "📬 No se encontró contenedor de mensajes en RootFolder de EWS"
    );
    return [];
  }

  const msgs = ensureArray(messagesContainer.Message);
  logger.info(
    `📬 EWS devolvió ${msgs.length} mensaje(s) no leído(s) como candidato(s)`
  );

  return msgs.map((m) => {
    const id = m.ItemId?.$.Id || m.ItemId?.Id;
    const changeKey = m.ItemId?.$.ChangeKey || m.ItemId?.ChangeKey;
    const subject = m.Subject;
    const fromAddress =
      m.From?.Mailbox?.EmailAddress || m.From?.Mailbox?.Name || "unknown";
    const isRead = m.IsRead === true || m.IsRead === "true";
    const date = m.DateTimeReceived;

    return {
      id,
      changeKey,
      subject,
      fromAddress,
      isRead,
      date
    };
  });
}

async function getMessageDetails(id, changeKey) {
  const getItemSoap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2010"/>
  </soap:Header>
  <soap:Body>
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:BodyType>Text</t:BodyType>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="message:From"/>
          <t:FieldURI FieldURI="message:ToRecipients"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="item:Body"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:ItemIds>
        <t:ItemId Id="${id}" ChangeKey="${changeKey}"/>
      </m:ItemIds>
    </m:GetItem>
  </soap:Body>
</soap:Envelope>`;

  const raw = await callEwsSoap(getItemSoap);
  const parsed = await parseSoap(raw);

  const msg =
    parsed?.Envelope?.Body?.GetItemResponse?.ResponseMessages
      ?.GetItemResponseMessage?.Items?.Message;

  if (!msg) {
    throw new Error("GetItemResponseMessage.Message not found");
  }

  const subject = msg.Subject;
  const fromAddress =
    msg.From?.Mailbox?.EmailAddress || msg.From?.Mailbox?.Name || "unknown";

  const toRecipients = ensureArray(msg.ToRecipients?.Mailbox);
  const toAddress = toRecipients
    .map((m) => m.EmailAddress || m.Name)
    .filter(Boolean)
    .join(", ") || "unknown";

  const date = msg.DateTimeReceived || msg.DateTimeCreated || new Date();
  const dateStr = formatDateForDisplay(date);

  const plainBody = getText(msg.Body);

  return {
    subject,
    fromAddress,
    toAddress,
    dateStr,
    plainBody
  };
}

async function markMessageAsRead(id, changeKey) {
  const updateSoap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2010"/>
  </soap:Header>
  <soap:Body>
    <m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AutoResolve">
      <m:ItemChanges>
        <t:ItemChange>
          <t:ItemId Id="${id}" ChangeKey="${changeKey}"/>
          <t:Updates>
            <t:SetItemField>
              <t:FieldURI FieldURI="message:IsRead"/>
              <t:Message>
                <t:IsRead>true</t:IsRead>
              </t:Message>
            </t:SetItemField>
          </t:Updates>
        </t:ItemChange>
      </m:ItemChanges>
    </m:UpdateItem>
  </soap:Body>
</soap:Envelope>`;

  try {
    await callEwsSoap(updateSoap);
  } catch (err) {
    logger.error(
      `⚠️ Failed to mark message ${id} as read in EWS: ${err.message}`
    );
  }
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
  try {
    logger.info(`🔐 Consultando EWS por NTLM en ${CONFIG.ews.url}`);

    // 1) Buscar mensajes no leídos en la carpeta configurada
    const candidates = await findUnreadMessages();
    logger.info(`📬 EWS encontró ${candidates.length} mensaje(s) no leído(s)`);

    for (const meta of candidates) {
      const { id, changeKey, subject, fromAddress, isRead } = meta;

      if (!id) {
        continue;
      }

      if (isRead) {
        // Por si EWS devolviera algo marcadocomo leído igualmente.
        continue;
      }

      if (processedUids.has(id)) {
        // Ya procesado en una ejecución anterior
        continue;
      }

      // 2) Traer detalles completos del mensaje (cuerpo, destinatarios, fecha...)
      let details;
      try {
        details = await getMessageDetails(id, changeKey);
      } catch (err) {
        logger.error(
          `⚠️ No se pudieron obtener los detalles del mensaje (remitente ${fromAddress}): ${err.message}`
        );
        continue;
      }

      const { toAddress, dateStr, plainBody } = details;

      // Log principal: solo remitente y fecha/hora
      logger.info(
        `🗒️ Analizando correo de ${fromAddress} recibido ${dateStr}`
      );

      const contentForAnalysis = `Asunto: ${subject ?? ""}\nRemitente: ${
        fromAddress ?? ""
      }\nPara: ${toAddress}\nFecha: ${dateStr}\n\n${plainBody}`;

      // 3) Análisis con LLM
      let analysis;
      try {
        analysis = await analyseMessage(contentForAnalysis);
      } catch (e) {
        logger.error(
          `⚠️ LLM failed for message ${id ?? "(sin UID)"}: ${e.message}`
        );
        continue;
      }

      const verdict =
        typeof analysis === "string" ? analysis : analysis.verdict;
      const analysisText =
        typeof analysis === "string" ? "" : analysis.analysisText || "";

      logger.info(
        `🤖 Resultado de Ollama para correo de ${fromAddress}: "${verdict}"`
      );

      // 4) Si es ALERTA, enviar a Slack (solo con análisis IA)
      if (verdict && verdict.includes("ALERTA")) {
        await sendSlackAlert({
          subject,
          from: fromAddress,
          date: dateStr,
          // Enviamos SOLO el análisis de IA a Slack (sin cuerpo del correo)
          summary: analysisText || "(sin análisis IA)"
        });
        logger.info(
          `🚨 ALERTA enviada a Slack para correo de ${fromAddress} (${dateStr})`
        );
      } else {
        logger.info(
          `✅ Correo de ${fromAddress} (${dateStr}) considerado OK por el analizador`
        );
      }

      // 5) Marcar como leído en EWS y registrar como procesado localmente
      await markMessageAsRead(id, changeKey);
      processedUids.add(id);
      persistProcessed();
    }
  } catch (err) {
    const extraParts = [];
    if (err && typeof err === "object") {
      if (err.name) extraParts.push(`name=${err.name}`);
      if (err.code) extraParts.push(`code=${err.code}`);
      if (err.statusCode) extraParts.push(`statusCode=${err.statusCode}`);
      if (err.responseCode) extraParts.push(`responseCode=${err.responseCode}`);
      if (err.innerException?.message) {
        extraParts.push(`inner=${err.innerException.message}`);
      }
    }

    logger.error(
      `❌ Error al consultar EWS: ${err.message}${
        extraParts.length ? " | " + extraParts.join(" ") : ""
      }`
    );
  }
}


