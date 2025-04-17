import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') }); // Загружаем .env из корня проекта

// Функция для безопасного получения переменной окружения
function getEnvVar(key: string, required = true): string {
  const value = process.env[key];
  if (required && (value === undefined || value === '')) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || '';
}

// Функция для безопасного получения числовой переменной окружения
function getEnvVarAsNumber(key: string, required = true): number {
  const value = getEnvVar(key, required);
  if (value === '' && !required) return 0; // Возвращаем 0 для необязательных пустых значений
  const numberValue = parseFloat(value);
  if (isNaN(numberValue)) {
    throw new Error(`Environment variable ${key} must be a valid number.`);
  }
  return numberValue;
}

// Функция для безопасного получения булевой переменной окружения
function getEnvVarAsBoolean(key: string, defaultValue = false): boolean {
  const value = process.env[key]?.toLowerCase();
  if (value === undefined || value === '') {
      return defaultValue;
  }
  return value === 'true';
}


// Тип для конфигурации
export interface ConfigType {
  tradingWalletPrivateKey: string;
  jitoAuthPrivateKey: string;
  heliusApiKey: string;
  shyftApiKey: string;
  shyftGrpcEndpoint: string;
  heliusRpcUrl: string;
  jitoBlockEngineUrl: string;
  pumpFunProgramId: string;
  buyAmountSol: number;
  slippageBps: number;
  jitoTipAccountPubkey: string;
  jitoFixedTipLamports: number;
  maxSlotAgeTolerance: number;
  defaultComputeUnits: number;
  priorityFeeMicroLamports: number;
  tp1McMult: number;
  tp1SellPct: number;
  tp2McMult: number;
  tp2SellPct: number;
  entrySlPct: number;
  maxMcSlPct: number;
  stagnationTimeoutSec: number;
  mcCheckIntervalMs: number;
  logLevel: string;
  logToFile: boolean;
}

// Экспортируем типизированный объект конфигурации
export const config: ConfigType = {
  tradingWalletPrivateKey: getEnvVar('TRADING_WALLET_PRIVATE_KEY'),
  jitoAuthPrivateKey: getEnvVar('JITO_AUTH_PRIVATE_KEY'),
  heliusApiKey: getEnvVar('HELIUS_API_KEY'),
  shyftApiKey: getEnvVar('SHYFT_API_KEY'),
  shyftGrpcEndpoint: getEnvVar('SHYFT_GRPC_ENDPOINT', false) || 'grpc.fra.shyft.to',
  heliusRpcUrl: getEnvVar('HELIUS_RPC_URL'),
  jitoBlockEngineUrl: getEnvVar('JITO_BLOCK_ENGINE_URL'),
  pumpFunProgramId: getEnvVar('PUMP_FUN_PROGRAM_ID'),
  buyAmountSol: getEnvVarAsNumber('BUY_AMOUNT_SOL'),
  slippageBps: getEnvVarAsNumber('SLIPPAGE_BPS'),
  jitoTipAccountPubkey: getEnvVar('JITO_TIP_ACCOUNT_PUBKEY'),
  jitoFixedTipLamports: getEnvVarAsNumber('JITO_FIXED_TIP_LAMPORTS'),
  maxSlotAgeTolerance: getEnvVarAsNumber('MAX_SLOT_AGE_TOLERANCE', false) || 10,
  defaultComputeUnits: getEnvVarAsNumber('DEFAULT_COMPUTE_UNITS', false) || 400000,
  priorityFeeMicroLamports: getEnvVarAsNumber('PRIORITY_FEE_MICRO_LAMPORTS', false) || 10000,
  tp1McMult: getEnvVarAsNumber('TP1_MC_MULT', false) || 1.5,
  tp1SellPct: getEnvVarAsNumber('TP1_SELL_PCT', false) || 40,
  tp2McMult: getEnvVarAsNumber('TP2_MC_MULT', false) || 2.0,
  tp2SellPct: getEnvVarAsNumber('TP2_SELL_PCT', false) || 60,
  entrySlPct: getEnvVarAsNumber('ENTRY_SL_PCT', false) || 5,
  maxMcSlPct: getEnvVarAsNumber('MAX_MC_SL_PCT', false) || 10,
  stagnationTimeoutSec: getEnvVarAsNumber('STAGNATION_TIMEOUT_SEC', false) || 12,
  mcCheckIntervalMs: getEnvVarAsNumber('MC_CHECK_INTERVAL_MS', false) || 100,
  logLevel: getEnvVar('LOG_LEVEL', false) || 'info',
  logToFile: getEnvVarAsBoolean('LOG_TO_FILE', true)
}; 