import cron from "node-cron";
import { CONFIG } from "./config.js";
import { checkMailbox } from "./mailWatcher.js";
import logger from "./utils/logger.js";

async function start() {
  logger.info("🚀 mcp-mailwatcher starting...");

  // Ejecutar una vez al inicio para procesar correos pendientes
  await checkMailbox();

  // Programar ejecución periódica
  const cronExp = `*/${CONFIG.pollInterval} * * * *`;
  cron.schedule(cronExp, async () => {
    logger.info("⏰ Scheduled check triggered");
    try {
      await checkMailbox();
    } catch (e) {
      logger.error(`❗ Scheduled run failed: ${e.message}`);
    }
  });

  logger.info(`⏳ Scheduler set – every ${CONFIG.pollInterval} minute(s)`);
}

start().catch((e) => {
  logger.error(`💥 Fatal error on startup: ${e.message}`);
  process.exit(1);
});


