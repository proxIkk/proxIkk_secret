import { Connection, Keypair } from '@solana/web3.js';
import { Helius } from 'helius-sdk';
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher'; // Попробуем импорт из dist
// import { SearcherClient } from 'jito-ts'; // Убираем попытку импорта класса
import { ShyftSdk, Network } from '@shyft-to/js';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import { ConfigType } from '../config/config';
import { BotContext, BotStats } from '../types/types';
import { Wallet } from '@coral-xyz/anchor'; // Используем Wallet из Anchor для Jito
import logger from '../utils/logger';
import { AnchorProvider, Program, Idl } from '@coral-xyz/anchor';
import { Mutex } from 'async-mutex';
// import { PumpFunSDK } from 'pumpdotfun-sdk'; // УДАЛЯЕМ
import pumpFunIdlJson from '../../pump-fun.json'; // <<<--- ИМПОРТИРУЕМ НОВЫЙ IDL ИЗ КОРНЯ
import { PublicKey } from '@solana/web3.js'; // Убедимся, что PublicKey импортирован
import { Pump } from '../types/pump_idl'; // <<<--- Импортируем тип Pump

// Helper функция для создания Keypair из приватного ключа Base58
function getKeypairFromPrivateKey(privateKey: string): Keypair {
  try {
    return Keypair.fromSecretKey(bs58.decode(privateKey));
  } catch (error) {
    logger.error({ error, privateKeySource: privateKey.substring(0, 5) + '...' }, 'Failed to decode private key');
    throw new Error('Invalid private key format. Please use Base58 encoding.');
  }
}

/**
 * Инициализирует все необходимые сервисы и SDK для работы бота.
 * @param config Загруженная конфигурация.
 * @returns Проинициализированный BotContext.
 */
export async function initializeServices(config: ConfigType): Promise<BotContext> {
  logger.info('Initializing services...');

  // 1. Solana Connection (через Helius RPC)
  const solanaConnection = new Connection(config.heliusRpcUrl, 'confirmed');
  logger.info(`Connected to Solana RPC: ${config.heliusRpcUrl}`);

  // <<<--- Тестовый RPC запрос --- >>>
  try {
    logger.info('Testing Helius RPC connection with getEpochInfo()...');
    const epochInfo = await solanaConnection.getEpochInfo('confirmed');
    logger.info({ epoch: epochInfo.epoch, slotIndex: epochInfo.slotIndex }, 'Helius RPC connection test successful!');
  } catch (testError: any) {
    logger.error({ error: testError.message }, 'Helius RPC connection test FAILED!');
    // Можно здесь прервать инициализацию, если соединение не работает
    // throw new Error('RPC Connection Test Failed'); 
  }
  // <<<--- Конец тестового запроса --- >>>

  // 2. Helius Client
  const heliusClient = new Helius(config.heliusApiKey);
  logger.info('Helius client initialized.');

  // 3. Кошельки
  const tradingWallet = getKeypairFromPrivateKey(config.tradingWalletPrivateKey);
  const jitoAuthWallet = getKeypairFromPrivateKey(config.jitoAuthPrivateKey);
  logger.info(`Trading wallet loaded: ${tradingWallet.publicKey.toBase58()}`);
  logger.info(`Jito auth wallet loaded: ${jitoAuthWallet.publicKey.toBase58()}`);

  // 4. Jito Client
  const jitoClient = searcherClient(
    config.jitoBlockEngineUrl,
    jitoAuthWallet,
    { 
      'grpc.keepalive_time_ms': 5000,
      'grpc.keepalive_timeout_ms': 10000,
      'grpc.http2.min_time_between_pings_ms': 10000,
      'grpc.http2.max_pings_without_data': 0,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.max_receive_message_length': 20 * 1024 * 1024, // 20MB для больших сообщений
      'grpc.max_send_message_length': 20 * 1024 * 1024, // 20MB для больших сообщений
    }
  );

  // Добавляем обработчики событий Jito
  jitoClient.onBundleResult(
    (bundleResult: any) => {
      // Обработка результатов бандла (успех/неудача)
      logger.info({ bundleResult }, 'Received Jito bundle result via gRPC stream');
    },
    (error: any) => {
      // Обработка ошибок Jito
      logger.error({ error }, 'Error receiving Jito bundle result via gRPC stream');
    }
  );
  logger.info(`Jito gRPC client initialized for block engine: ${config.jitoBlockEngineUrl}`);

  // Тестируем соединение с Jito gRPC, запрашивая tip аккаунты
  try {
    logger.info('Testing Jito gRPC connection by requesting tip accounts...');
    const result = await jitoClient.getTipAccounts();
    if ('ok' in result && result.ok === true) {
      const tipAccounts = result.value;
      logger.info({ 
        tipAccountsCount: tipAccounts.length,
        tipAccounts: tipAccounts.slice(0, 3).concat(tipAccounts.length > 3 ? ['...'] : [])
      }, 'Jito gRPC connection test successful!');
      
      // Проверяем, что настроенный tipAccount существует в списке доступных
      const configuredTipAccount = config.jitoTipAccountPubkey;
      const isConfiguredTipAccountValid = tipAccounts.includes(configuredTipAccount);
      if (!isConfiguredTipAccountValid) {
        logger.warn({ 
          configuredTipAccount,
          availableTipAccounts: tipAccounts
        }, 'Configured Jito tip account not found in available tip accounts!');
      } else {
        logger.info({ tipAccount: configuredTipAccount }, 'Configured Jito tip account is valid');
      }
    } else if ('ok' in result && result.ok === false) {
      logger.error({ 
        error: result.error.message,
        code: result.error.code,
        details: result.error.details
      }, 'Jito gRPC connection test FAILED when requesting tip accounts!');
    } else {
      logger.error({ result }, 'Unexpected result format from Jito gRPC tip accounts request');
    }
  } catch (testError: any) {
    logger.error({ error: testError }, 'Unexpected error during Jito gRPC connection test!');
  }

  // 5. Anchor Provider и Anchor Program для Pump.fun
  const provider = new AnchorProvider(solanaConnection, new Wallet(tradingWallet), {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed'
  });
  logger.info('Anchor Provider initialized.'); 
  
  // <<<--- Используем новый IDL --- >>>
  const pumpFunIdl: Pump = pumpFunIdlJson as unknown as Pump; 
  // Конструктор возьмет адрес из pumpFunIdl.address
  const pumpFunProgram = new Program<Pump>(pumpFunIdl, provider);
  logger.info(`Pump.fun Anchor Program initialized for program ID: ${pumpFunProgram.programId.toBase58()} (from IDL)`);
  // Проверка на несоответствие с конфигом остается полезной
  if (pumpFunProgram.programId.toBase58() !== config.pumpFunProgramId) {
      logger.warn(`Mismatch between program ID in IDL (${pumpFunProgram.programId.toBase58()}) and config (${config.pumpFunProgramId}). Using ID from IDL.`);
  }
  
  // УДАЛЯЕМ ИНИЦИАЛИЗАЦИЮ PUMP SDK
  // const pumpSdk = new PumpFunSDK(provider); 
  // logger.info('Pump.fun SDK initialized.');

  // 6. Shyft Client
  const shyftClient = new ShyftSdk({
    apiKey: config.shyftApiKey,
    network: Network.Mainnet,
  });
  logger.info('Shyft SDK initialized.');

  // 7. Создание BotContext
  const initialBotStats: BotStats = {
      totalTrades: 0,
      successfulTrades: 0,
      failedBuys: 0,
      failedSells: 0,
      totalPnlPercent: 0,
  };
  
  const botContext: BotContext = {
    solanaConnection,
    heliusClient,
    jitoClient,
    // pumpSdk, // УДАЛЯЕМ
    pumpFunProgram, // Передаем Program<Pump>
    shyftClient,
    config,
    latestBlockhash: '',
    currentSolPrice: 0,
    tradingWallet,
    jitoAuthWallet,
    activeCoin: null,
    activeCoinLock: new Mutex(),
    trackingIntervalId: null,
    botStats: initialBotStats, 
  };

  logger.info('All services initialized successfully.');
  return botContext;
} 