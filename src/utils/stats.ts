import { BotContext, CoinPosition, TradeResult } from '../types/types';
import fs from 'fs/promises'; // Используем промисы для асинхронной записи
import path from 'path';
import logger from './logger';

const STATS_FILE_PATH = path.resolve(__dirname, '../../trades/trades.csv'); // Путь к файлу статистики в папке trades
const CSV_HEADER = 'Timestamp,Mint,Symbol,Name,Buy Timestamp,Sell Timestamp,Duration (s),Buy Tx,Sell Tx,Buy Amount (SOL),Initial MC,Final MC,Max MC,PnL (%),Sell Reason,Buy Sim Error,Buy Error,Sell Error\n';

/**
 * Рассчитывает статистику по завершенной сделке и записывает ее в файл.
 * @param coin Завершенная позиция по монете.
 * @param context Контекст бота.
 */
export async function recordTradeStats(coin: CoinPosition, context: BotContext): Promise<void> {
    logger.info({ mint: coin.mint }, 'Recording trade statistics...');
    context.botStats.totalTrades++;

    let pnlPercent: number | undefined = undefined;
    let isSuccess = false;

    // Считаем сделку успешной, если был выполнен buy и state = 'sold' (даже если sellTx нет - например, баланс был 0)
    if (coin.buyTxSignature && coin.state === 'sold') {
        isSuccess = true;
        context.botStats.successfulTrades++;
        // Рассчитываем PnL % на основе MC
        if (coin.initialMarketCap && coin.initialMarketCap > 0 && coin.currentMarketCap) {
            pnlPercent = ((coin.currentMarketCap / coin.initialMarketCap) - 1) * 100;
            context.botStats.totalPnlPercent += pnlPercent;
        }
    } else if (coin.buyError || coin.buySimError) {
        context.botStats.failedBuys++;
    } else if (coin.sellError) {
        context.botStats.failedSells++;
    }

    const sellTimestamp = Date.now(); // Время записи статистики
    const durationSec = coin.detectedTimestamp ? Math.round((sellTimestamp - coin.detectedTimestamp) / 1000) : 0;
    
    const tradeResult: TradeResult = {
        timestamp: new Date(sellTimestamp).toISOString(),
        mint: coin.mint || 'N/A',
        symbol: coin.tokenSymbol || 'N/A',
        name: coin.tokenName || 'N/A',
        buyTimestamp: coin.detectedTimestamp, // Используем detectedTimestamp как время начала
        sellTimestamp: sellTimestamp,
        durationSec: durationSec,
        buyTx: coin.buyTxSignature || 'N/A',
        sellTx: coin.sellTxSignature || (coin.state === 'sold' ? 'N/A (Balance 0?) ' : 'N/A'),
        buyAmountSol: context.config.buyAmountSol,
        initialMarketCap: coin.initialMarketCap,
        finalMarketCap: coin.currentMarketCap, 
        maxMarketCap: coin.maxMarketCap,
        pnlPercent: pnlPercent,
        sellReason: coin.sellReason || (isSuccess ? 'Unknown (Sold)' : 'N/A'),
        buySimError: coin.buySimError,
        buyError: coin.buyError,
        sellError: coin.sellError,
    };

    // Форматируем в CSV строку (простое экранирование кавычек)
    const formatCsvCell = (value: any): string => {
        if (value === undefined || value === null) return '';
        const str = String(value).replace(/"/g, '""'); // Экранируем кавычки
        return `"${str}"`; // Оборачиваем в кавычки
    };

    const csvRow = [
        tradeResult.timestamp,
        tradeResult.mint,
        tradeResult.symbol,
        tradeResult.name,
        tradeResult.buyTimestamp,
        tradeResult.sellTimestamp,
        tradeResult.durationSec,
        tradeResult.buyTx,
        tradeResult.sellTx,
        tradeResult.buyAmountSol,
        tradeResult.initialMarketCap,
        tradeResult.finalMarketCap,
        tradeResult.maxMarketCap,
        tradeResult.pnlPercent?.toFixed(2), // Округляем процент
        tradeResult.sellReason,
        tradeResult.buySimError,
        tradeResult.buyError,
        tradeResult.sellError
    ].map(formatCsvCell).join(',') + '\n';

    try {
        // Проверяем, существует ли файл. Если нет, создаем и пишем заголовок.
        try {
            await fs.access(STATS_FILE_PATH);
        } catch (accessError) {
            // Файл не существует, создаем директорию и файл с заголовком
            logger.info(`Stats file ${STATS_FILE_PATH} not found, creating...`);
            await fs.mkdir(path.dirname(STATS_FILE_PATH), { recursive: true });
            await fs.writeFile(STATS_FILE_PATH, CSV_HEADER);
            logger.info(`Created stats file with header.`);
        }
        
        // Дописываем строку в файл
        await fs.appendFile(STATS_FILE_PATH, csvRow);
        logger.info({ mint: coin.mint }, 'Successfully recorded trade statistics.');

    } catch (fileError) {
        logger.error({ mint: coin.mint, error: fileError }, 'Failed to write trade statistics to file.');
    }
    
    // Логируем общую статистику в консоль для информации
    logger.info({
         total: context.botStats.totalTrades,
         successful: context.botStats.successfulTrades,
         failedBuys: context.botStats.failedBuys,
         failedSells: context.botStats.failedSells,
         avgPnlPercent: context.botStats.successfulTrades > 0 ? (context.botStats.totalPnlPercent / context.botStats.successfulTrades).toFixed(2) : 'N/A'
        }, "Overall Bot Stats Updated");
}

/**
 * Сохраняет общую статистику бота в JSON файл.
 * @param context Контекст бота.
 */
export async function saveBotStats(context: BotContext): Promise<void> {
    const statsFilePath = path.resolve(__dirname, '../../logs/bot_summary.json');
    try {
         const statsToSave = {
             lastRunTimestamp: new Date().toISOString(),
             totalTrades: context.botStats.totalTrades,
             successfulTrades: context.botStats.successfulTrades,
             failedBuys: context.botStats.failedBuys,
             failedSells: context.botStats.failedSells,
             avgPnlPercent: context.botStats.successfulTrades > 0 
                            ? (context.botStats.totalPnlPercent / context.botStats.successfulTrades).toFixed(2) + '%' 
                            : 'N/A'
         };
         await fs.mkdir(path.dirname(statsFilePath), { recursive: true });
         await fs.writeFile(statsFilePath, JSON.stringify(statsToSave, null, 2));
         logger.info(`Bot summary statistics saved to ${statsFilePath}`);
    } catch (error) {
         logger.error({ error }, "Failed to save bot summary statistics.");
    }
} 