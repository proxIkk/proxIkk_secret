console.log("main.ts: Starting imports...");
import { config } from './config/config';
console.log("main.ts: Imported config");
import logger from './utils/logger';
console.log("main.ts: Imported logger");
import { initializeServices } from './services/init';
console.log("main.ts: Imported initializeServices");
import { startChainTracking } from './utils/chain-utils';
console.log("main.ts: Imported startChainTracking");
import { startShyftListener, stopShyftListener } from './core/shyft-listener';
console.log("main.ts: Imported startShyftListener");
import { BotContext } from './types/types';
console.log("main.ts: Imported BotContext");
import { signalShutdown, getActiveCoin, executeSell } from './core/logic';
import { saveBotStats } from './utils/stats';

console.log("main.ts: Defining runBot...");
let botCtx: BotContext | null = null;
let isShuttingDownProcess = false;

async function runBotInternal(): Promise<BotContext> {
  console.log("main.ts: runBot started");
  logger.info('Starting Pump.fun Sniper Bot...');

  try {
    // 1. Загрузка конфигурации (уже сделана при импорте)
    logger.info('Configuration loaded.');

    // 2. Инициализация сервисов
    const context = await initializeServices(config);

    // 3. Запуск отслеживания цепочки (слот, блокхеш, цена SOL)
    await startChainTracking(context);

    // 4. Запуск слушателя Shyft gRPC
    startShyftListener(context);

    logger.info('Bot is running. Waiting for events...');
    return context;
  } catch (error) {
    console.error("main.ts: Error in runBot:", error);
    logger.fatal({ error }, 'Fatal error during bot initialization');
    process.exit(1); // Выход с ошибкой
  }
}

console.log("main.ts: Defining shutdown handlers...");
// --- Обработка сигналов завершения и ошибок ---

async function handleShutdown(signal: string) {
  if (isShuttingDownProcess) {
    logger.warn(`Shutdown already in progress. Received signal ${signal} again.`);
    return;
  }
  isShuttingDownProcess = true;

  logger.info(`Received ${signal}. Shutting down gracefully...`);
  signalShutdown();

  if (botCtx) {
    const activeCoin = getActiveCoin(botCtx);
    if (activeCoin && activeCoin.state !== 'selling' && activeCoin.state !== 'sold' && activeCoin.state !== 'failed') {
      logger.warn({ mint: activeCoin.mint }, "Attempting to sell active coin before shutdown (with timeout)...");
      try {
        const sellSuccess = await executeSell(activeCoin, botCtx, 'ALL', true);
        if (sellSuccess) {
          logger.info({ mint: activeCoin.mint }, "Successfully sold/confirmed active coin during shutdown.");
        } else {
          logger.warn({ mint: activeCoin.mint }, "Failed to sell/confirm active coin during shutdown within timeout (check previous errors)." );
        }
      } catch (sellError) {
        logger.error({ mint: activeCoin.mint, error: sellError }, "Error executing sell active coin during shutdown.");
      }
    } else {
      logger.info("No active coin to sell or it's already being handled.");
    }
    
    logger.info("Closing connections...");
    stopShyftListener();
    
    logger.info("Shyft gRPC stream stopped (or attempted). Jito client likely closes automatically.");
    
    if (botCtx) {
      try {
        await saveBotStats(botCtx);
      } catch (statsError) {
        logger.error({ error: statsError }, "Error saving bot stats during shutdown.");
      }
    } else {
      logger.warn("Bot context became unavailable before saving stats during shutdown.");
    }

  } else {
    logger.warn("Bot context not available during shutdown.");
  }

  await new Promise(resolve => setTimeout(resolve, 1500));

  logger.info('Shutdown complete.');
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

process.on('uncaughtException', (error, origin) => {
  logger.fatal({ error, origin }, 'Uncaught Exception');
  handleShutdown('uncaughtException').finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  if (reason instanceof Error) {
    console.error(reason.stack);
  }
  logger.fatal({ reason, promise }, 'Unhandled Rejection');
  handleShutdown('unhandledRejection').finally(() => process.exit(1));
});

console.log("main.ts: Calling runBot()...");
// --- Запуск бота ---
async function main() {
  botCtx = await runBotInternal();
  logger.info("Bot main function reached end. Process will keep running due to listeners.")
}

main().catch(err => {
  logger.fatal({ error: err }, "Unhandled error in main execution");
  handleShutdown('main execution error').finally(() => process.exit(1));
});
console.log("main.ts: Called runBot(). Script end."); 