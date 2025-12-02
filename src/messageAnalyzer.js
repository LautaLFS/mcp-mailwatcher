import axios from "axios";
import { CONFIG } from "./config.js";
import logger from "./utils/logger.js";

/**
 * Envía el cuerpo del correo a Ollama y devuelve una decisión normalizada:
 * siempre "ALERTA" o "OK".
 *
 * Si el modelo no sigue bien las instrucciones, se aplican heurísticas
 * simples sobre el texto del correo para detectar palabras clave de problemas.
 *
 * Punto de ajuste principal:
 *  - CONFIG.prompt (en config.json) para cambiar el comportamiento del modelo
 *  - la lista problemKeywords de abajo para afinar qué se considera incidente
 */
export async function analyseMessage(body) {
  const prompt = CONFIG.prompt.replace("{body}", body);

  const payload = {
    model: CONFIG.ollama.model,
    prompt,
    stream: false,
    options: { temperature: 0.0 } // determinista
  };

  try {
    const resp = await axios.post(CONFIG.ollama.api, payload, {
      timeout: 30_000
    });
    const answerRaw =
      resp.data?.response?.trim() ?? resp.data?.response?.trim() ?? "";
    logger.info(`🔎 Ollama response: "${answerRaw}"`);

    let answer = answerRaw.toUpperCase();

    const hasAlerta = answer.includes("ALERTA");
    const hasOk = answer.includes("OK");

    if (hasAlerta && !hasOk) {
      return "ALERTA";
    }
    if (hasOk && !hasAlerta) {
      return "OK";
    }

    // Heurística de respaldo basada en el contenido del correo
    const text = body.toLowerCase();
    const problemKeywords = [
      "hubo un problema",
      "problema con la base de datos",
      "error en la base de datos",
      "error 500",
      "error 503",
      "caída del servicio",
      "servicio caido",
      "servicio caído",
      "no responde",
      "timeout",
      "fallo en la conexión",
      "falló la conexión",
      "crash",
      "exception",
      "excepción"
    ];

    const looksLikeProblem = problemKeywords.some((kw) => text.includes(kw));

    if (looksLikeProblem) {
      logger.info(
        "🧠 Heurística: el contenido parece describir un problema importante, devolviendo ALERTA aunque el modelo no lo haya marcado claramente."
      );
      return "ALERTA";
    }

    logger.info(
      '🧠 Heurística: el modelo no devolvió claramente "ALERTA" u "OK"; asumimos OK.'
    );
    return "OK";
  } catch (err) {
    logger.error(`❌ Ollama request failed: ${err.message}`);
    throw err;
  }
}


