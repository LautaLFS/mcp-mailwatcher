import cron from "node-cron";
import { CONFIG } from "./config.js";
import { checkMailbox } from "./mailWatcher.js";
import logger from "./utils/logger.js";

async function start() {
  logger.info("🚀 mcp-mailwatcher iniciando...");

  // Ejecutar una vez al inicio para procesar correos pendientes
  await checkMailbox();

  // Programar ejecución periódica
  const cronExp = `*/${CONFIG.pollInterval} * * * *`;
  cron.schedule(cronExp, async () => {
    logger.info("⏰ Ejecución programada disparada");
    try {
      await checkMailbox();
    } catch (e) {
      logger.error(`❗ Falló la ejecución programada: ${e.message}`);
    }
  });

  logger.info(
    `⏳ Planificador configurado: cada ${CONFIG.pollInterval} minuto(s)`
  );
}

start().catch((e) => {
  logger.error(`💥 Error fatal al iniciar: ${e.message}`);
  process.exit(1);
});


