import { ParsedPumpCreateData, BotContext } from '../types/types';
import logger from '../utils/logger';

/**
 * Основная функция обработки нового обнаруженного события создания монеты.
 * В Фазе 2 здесь будет логика фильтрации, симуляции и покупки.
 * @param eventData Данные об обнаруженной монете (без detectionSlot).
 * @param context Контекст бота.
 */
export function handleNewMintEvent(eventData: ParsedPumpCreateData, context: BotContext): void {
  // Логируем основные данные (без detectionSlot)
  logger.info({ 
    mint: eventData.mint, 
    creator: eventData.creator, 
    creationSlot: eventData.creationSlot, // Может быть undefined
    name: eventData.tokenName,
    symbol: eventData.tokenSymbol
  }, `🚀 Potential new token detected!`); 
  
  // TODO: Реализовать логику Фазы 2:
  // 1. Фильтрация (проверка создателя, метаданных и т.д.)
  // 2. Создание объекта CoinPosition
  // 3. Постановка в очередь на симуляцию/покупку
  // Пока что ничего не делаем, так как логика перенесена в logic.ts
  // Этот файл можно будет удалить или переделать позже.
} 