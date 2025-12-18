import axios from "axios";
import { CONFIG } from "./config.js";
import logger from "./utils/logger.js";

/**
 * Envía el cuerpo del correo a Ollama y devuelve un análisis estructurado:
 *  - verdict: siempre "ALERTA" o "OK".
 *  - analysisText: explicación completa generada por el modelo.
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
    logger.info(`🔎 Respuesta de Ollama: "${answerRaw}"`);

    let answerUpper = answerRaw.toUpperCase();

    const hasAlerta = answerUpper.includes("ALERTA");
    const hasOk = answerUpper.includes("OK");

    let verdict;

    if (hasAlerta && !hasOk) {
      verdict = "ALERTA";
    } else if (hasOk && !hasAlerta) {
      verdict = "OK";
    } else {
      verdict = "OK"; // por defecto, afinamos con heurística debajo
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

    if (looksLikeProblem && verdict !== "ALERTA") {
      logger.info(
        "🧠 Heurística: el contenido parece describir un problema importante; ajustamos veredicto a ALERTA aunque el modelo no lo haya marcado claramente."
      );
      verdict = "ALERTA";
    } else if (!looksLikeProblem && !hasAlerta && !hasOk) {
      logger.info(
        '🧠 Heurística: el modelo no devolvió claramente "ALERTA" u "OK"; asumimos OK.'
      );
      verdict = "OK";
    }

    // Intentar garantizar que el análisis esté en español: si detectamos que
    // el texto está mayoritariamente en inglés, pedimos a Ollama que lo
    // traduzca al español neutro manteniendo la estructura.
    let analysisText = answerRaw;

    const sample = analysisText.slice(0, 400).toLowerCase();
    const englishHints = ["this is", "log file", "overall", "the log", "error message", "warning", "connection reset"];
    const spanishHints = [" resumen", " errores", "causa raíz", "acciones sugeridas", "servicio", "sistema", "registro"];

    const englishScore = englishHints.filter((w) => sample.includes(w)).length;
    const spanishScore = spanishHints.filter((w) => sample.includes(w)).length;

    const seemsEnglish = englishScore > spanishScore && englishScore >= 1;

    if (seemsEnglish) {
      try {
        const translationPrompt =
          "Traduce al ESPAÑOL NEUTRO el siguiente análisis, manteniendo la estructura de secciones y viñetas, " +
          "pero SIN traducir nombres propios, rutas, comandos ni códigos de error. Responde solo con la traducción:\n\n" +
          analysisText;

        const translationResp = await axios.post(
          CONFIG.ollama.api,
          {
            model: CONFIG.ollama.model,
            prompt: translationPrompt,
            stream: false,
            options: { temperature: 0.0 }
          },
          { timeout: 30_000 }
        );

        const translated =
          translationResp.data?.response?.trim() ?? analysisText;
        analysisText = translated;
        logger.info("🌐 Análisis de Ollama traducido automáticamente al español.");
      } catch (e) {
        logger.error(
          `❌ Falló la traducción al español del análisis de Ollama: ${e.message}`
        );
        // En caso de error, nos quedamos con el texto original.
      }
    }

    return {
      verdict,
      analysisText
    };
  } catch (err) {
    logger.error(`❌ Falló la petición a Ollama: ${err.message}`);
    throw err;
  }
}


