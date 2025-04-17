import { Connection, PublicKey, Keypair, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { Helius } from 'helius-sdk';
import { SearcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';
import { ShyftSdk } from '@shyft-to/js';
import { Mutex } from 'async-mutex';
import { ConfigType } from '../config/config';
import { Program, Idl } from '@coral-xyz/anchor';
import { Pump } from './pump_idl';

/**
 * Состояние отслеживаемой монеты
 */
export type CoinState =
  | 'detected'
  | 'filtering'
  | 'simulating'
  | 'buying'
  | 'tracking'
  | 'selling'
  | 'sold'
  | 'failed';

/**
 * Представляет позицию по конкретной монете, которую отслеживает бот.
 */
export interface CoinPosition {
  mint: string;
  bondingCurve: string;
  creator: string;
  tokenName: string;
  tokenSymbol: string;
  tokenUri: string;
  state: CoinState;
  detectedTimestamp: number;
  creationSlot?: number; // Опциональный
  // Поля, заполняемые в процессе
  creatorATA?: string;
  creatorBuySol?: number;
  tokensHeld?: string;
  initialMarketCap?: number;
  currentMarketCap?: number;
  maxMarketCap?: number;
  lastMarketCapUpdateTime?: Date;
  creatorSold?: boolean;
  buyTxSignature?: string;
  sellTxSignature?: string;
  buySimError?: string;
  buyError?: string;
  sellError?: string;
  soldTp1?: boolean;
  soldTp2?: boolean;
  sellReason?: string;
}

/**
 * Данные, извлеченные из события pumpfun.Create...
 */
export interface ParsedPumpCreateData {
  signature: string;
  timestamp: string;
  creationSlot?: number; // Опциональный
  mint: string;
  bondingCurve: string;
  creator: string;
  tokenName: string;
  tokenSymbol: string;
  tokenUri: string;
}

// Фабричная функция для CoinPosition
export function createCoinPosition(data: ParsedPumpCreateData): CoinPosition {
    return {
        mint: data.mint,
        bondingCurve: data.bondingCurve,
        creator: data.creator,
        tokenName: data.tokenName,
        tokenSymbol: data.tokenSymbol,
        tokenUri: data.tokenUri,
        state: 'detected',
        detectedTimestamp: new Date(data.timestamp).getTime(),
        creationSlot: data.creationSlot,
        soldTp1: false,
        soldTp2: false,
        sellReason: undefined,
        // Остальные поля инициализируются как undefined по умолчанию
    };
}

// <<<--- Добавляем интерфейс для Статистики Сделки --- >>>
export interface TradeResult {
    timestamp: string;       // Время завершения сделки (ISO)
    mint: string;
    symbol: string;
    name: string;
    buyTimestamp: number;    // Timestamp покупки (ms)
    sellTimestamp: number;   // Timestamp продажи (ms)
    durationSec: number;     // Длительность сделки (секунды)
    buyTx: string;           // Сигнатура покупки
    sellTx: string;          // Сигнатура продажи
    buyAmountSol: number;    // Сумма покупки в SOL
    // sellAmountSol?: number; // Приблизительная сумма продажи в SOL (TODO: рассчитать точнее)
    initialMarketCap?: number;
    finalMarketCap?: number;  // MC на момент продажи
    maxMarketCap?: number;
    pnlPercent?: number;     // PnL в процентах (оценка по MC)
    sellReason?: string;     // Причина продажи (из checkSellConditions)
    buySimError?: string;
    buyError?: string;
    sellError?: string;     // Ошибка, если продажа не удалась
}

// <<<--- Добавляем интерфейс для Общей Статистики --- >>>
export interface BotStats {
    totalTrades: number;
    successfulTrades: number;
    failedBuys: number;
    failedSells: number;
    totalPnlPercent: number; // Суммарный % PnL
    // Добавить другие счетчики по желанию
}

/**
 * Главный контекстный объект бота.
 */
export interface BotContext {
    solanaConnection: Connection;
    heliusClient: Helius;
    jitoClient: any; // Оставляем any для Jito пока
    pumpFunProgram: Program<Pump>;
    shyftClient: ShyftSdk;
    config: ConfigType;
    latestBlockhash: string;
    currentSolPrice: number;
    tradingWallet: Keypair;
    jitoAuthWallet: Keypair;
    activeCoin: CoinPosition | null;
    activeCoinLock: Mutex;
    trackingIntervalId: NodeJS.Timeout | null;
    botStats: BotStats;
}

// Интерфейс DetectedCoinData удален 