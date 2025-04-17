import { BotContext } from '../types/types';
import logger from './logger';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import axios from 'axios';

const UPDATE_INTERVAL_MS = 500; // Интервал обновления слота/блокхеша (500 мс)
const PRICE_UPDATE_INTERVAL_MS = 60000; // Интервал обновления цены SOL (1 минута)

/**
 * Получает текущую цену SOL/USD с использованием CoinGecko API через axios.
 * @param context Контекст бота.
 */
async function updateSolPrice(context: BotContext): Promise<void> {
  try {
    const coingeckoUrl = `https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd`;
    logger.trace({ url: coingeckoUrl }, "Fetching SOL price from CoinGecko via axios...");
    
    // <<<--- Используем axios для запроса к CoinGecko --- >>>
    const response = await axios.get(coingeckoUrl, {
        timeout: 5000 // Таймаут 5 секунд
    });

    const priceData = response.data;
    logger.trace({ priceData }, "Received price data from CoinGecko"); // Логируем ответ

    // Извлекаем цену из ответа CoinGecko
    const price = priceData?.solana?.usd;

    if (typeof price === 'number') {
        context.currentSolPrice = price;
        logger.info({ price: context.currentSolPrice }, 'Updated SOL/USD price via CoinGecko');
    } else {
        logger.warn({ response: priceData }, 'Could not extract SOL price from CoinGecko response');
    }

  } catch (error: any) {
    // Логирование ошибки axios при запросе к CoinGecko
    const errorDetails = {
        message: error.message,
        code: error.code,
        url: error.config?.url, 
        status: error.response?.status,
        data: error.response?.data, 
        stack: error.stack
    };
    logger.error({ error: errorDetails }, 'Failed to update SOL price via CoinGecko');
  }
}

/**
 * Запускает периодическое обновление последнего блокхеша.
 * @param context Контекст бота.
 */
export async function startChainTracking(context: BotContext): Promise<void> {
  logger.info('Starting chain tracking (blockhash, SOL price)...');

  // Получаем цену SOL
  await updateSolPrice(context);
  setInterval(() => updateSolPrice(context), PRICE_UPDATE_INTERVAL_MS);

  // Запускаем периодическое обновление блокхеша
  setInterval(async () => {
    try {
      // Получаем последний блокхеш 
      // Запрашиваем его всегда, так как нет привязки к слоту
      const blockhashResponse = await context.solanaConnection.getLatestBlockhash('confirmed');
      // <<<--- Проверяем, изменился ли блокхеш перед обновлением --- >>>
      if (blockhashResponse.blockhash !== context.latestBlockhash) { 
          context.latestBlockhash = blockhashResponse.blockhash;
          logger.trace({ blockhash: context.latestBlockhash, lastValidBlockHeight: blockhashResponse.lastValidBlockHeight }, 'Updated latest blockhash');
      }
      
    } catch (error) {
      logger.error({ error }, 'Failed to update blockhash');
    }
  }, UPDATE_INTERVAL_MS);

  // Первоначальное получение блокхеша
  try {
      const blockhashResponse = await context.solanaConnection.getLatestBlockhash('confirmed');
      context.latestBlockhash = blockhashResponse.blockhash;
      logger.info({ blockhash: context.latestBlockhash }, 'Initial blockhash fetched');
  } catch (error) {
      logger.error({ error }, 'Failed to fetch initial blockhash');
  }
} 