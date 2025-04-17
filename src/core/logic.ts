import { Mutex } from 'async-mutex';
import { 
    BotContext, 
    ParsedPumpCreateData, 
    CoinPosition, 
    createCoinPosition 
} from '../types/types';
import logger from '../utils/logger';
import { 
    Keypair, 
    PublicKey, 
    LAMPORTS_PER_SOL,
    ComputeBudgetProgram,
    Transaction,
    SystemProgram,
    SYSVAR_RENT_PUBKEY,
    AccountInfo,
    TransactionInstruction,
    VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { waitForTransactionConfirmation } from '../utils/transaction-utils';
import {
    getAssociatedTokenAddressSync, 
    createAssociatedTokenAccountInstruction,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID 
} from '@solana/spl-token';
import axios from 'axios';
import BN from 'bn.js';
import { recordTradeStats } from '../utils/stats';
import { rpcWithRetry } from '../utils/rpc-utils';
import { IdlAccounts } from '@coral-xyz/anchor'; 
import { Pump } from '../types/pump_idl';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';
import Decimal from 'decimal.js';

// <<<--- Глобальный флаг завершения --- >>>
let isShuttingDown = false;

// Мьютекс для предотвращения одновременной обработки нескольких монет
const activeCoinLock = new Mutex();

// Константы
const RPC_TIMEOUT_MS = 5000; // 5 секунд
// Убираем старые константы для ретраев покупки, так как rpcWithRetry используется иначе
// const BUY_RETRY_DELAY_MS = 200;
// const MAX_BUY_RETRIES = 5;

// <<<--- Новые константы для повторных попыток загрузки кривой --- >>>
const BONDING_CURVE_FETCH_RETRIES = 5; // Количество попыток загрузки данных кривой
const BONDING_CURVE_FETCH_DELAY_MS = 300; // Задержка между попытками (мс)

// <<<--- Добавляем константы для PDA и аккаунтов Pump.fun (ПРОВЕРИТЬ АДРЕСА!) --- >>>
const GLOBAL_ACCOUNT_PUBKEY = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"); // <<<--- Уже обновлен
const FEE_RECIPIENT_PUBKEY = new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV"); // <<<--- Новый адрес!
const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SYSTEM_PROGRAM_ID = SystemProgram.programId;

// <<<--- Восстанавливаем схему Borsh --- >>>
// const BONDING_CURVE_LAYOUT = borsh.struct([...]);

// Интерфейс для данных, ИЗВЛЕЧЕННЫХ из аккаунта кривой
// Используем поля из сгенерированного типа Pump
interface BondingCurveData {
    virtualTokenReserves: BN; 
    virtualSolReserves: BN;
    realTokenReserves: BN;
    realSolReserves: BN;
    tokenTotalSupply: BN;
    complete: boolean;
}

// <<<--- Тип аккаунта: Пробуем bondingCurve с маленькой буквы --- >>>
type BondingCurveAccount = IdlAccounts<Pump>['bondingCurve']; // Изменяем на camelCase

/**
 * Основная функция обработки нового обнаруженного события создания монеты.
 * @param eventData Данные об обнаруженной монете.
 * @param context Контекст бота.
 */
export async function handleNewMintEvent(eventData: ParsedPumpCreateData, context: BotContext): Promise<void> {
    // <<<--- Проверка флага завершения --- >>>
    if (isShuttingDown) {
        logger.info({ mint: eventData.mint }, "Shutting down, skipping new mint event.");
        return;
    }
    try {
        logger.trace({ 
            mint: eventData.mint, 
            currentActiveCoin: context.activeCoin ? context.activeCoin.mint : null, 
            mutexLocked: activeCoinLock.isLocked() 
        }, 'handleNewMintEvent triggered');
        
        logger.trace({ 
            mint: eventData.mint, 
            creator: eventData.creator, 
            name: eventData.tokenName, 
            symbol: eventData.tokenSymbol
          }, `🚀 Potential new token detected!`);

        await activeCoinLock.runExclusive(async () => {
            try {
                if (context.activeCoin) {
                    logger.trace({ 
                        currentMint: context.activeCoin.mint, 
                        skippedMint: eventData.mint 
                    }, 'Already processing a coin, skipping new mint');
                    return; 
                }

                logger.debug({ mint: eventData.mint }, 'Acquired lock, starting processing...');

                try {
                    const newCoin = createCoinPosition(eventData);
                    newCoin.state = 'buying'; 
                    context.activeCoin = newCoin; 

                    logger.info({ mint: newCoin.mint }, 'Filters passed, attempting buy...');
                    
                    const buySuccess = await executeBuy(newCoin, context);

                    if (!buySuccess) {
                        logger.warn({ mint: newCoin.mint }, 'Buy execution failed or unconfirmed, resetting active coin.');
                        context.activeCoin = null;
                    }
                } catch (buyError) {
                    logger.error({ mint: eventData.mint, error: buyError }, 'Error during buy phase within lock, resetting active coin.');
                    context.activeCoin = null; 
                }
            } catch (innerError) {
                logger.error({ mint: eventData.mint, error: innerError }, 'Error inside runExclusive block');
                if (context.activeCoin?.mint === eventData.mint) { 
                    context.activeCoin = null;
                }
            }
        });
        

    } catch (outerError) {
         logger.error({ mint: eventData.mint, error: outerError }, 'Error in handleNewMintEvent (outer catch)');
    }
}

/**
 * Выполняет покупку с использованием Anchor.
 */
export async function executeBuy(coin: CoinPosition, context: BotContext): Promise<boolean> {
    try {
        const tradingWalletKp = context.tradingWallet;
        const mintPublicKey = new PublicKey(coin.mint);
        const bondingCurvePublicKey = new PublicKey(coin.bondingCurve);
        const connection = context.solanaConnection;
        const pumpFunProgram = context.pumpFunProgram; // <<<--- Program<Pump>
        const amountInSol = context.config.buyAmountSol;
        const amountInLamportsBigInt = BigInt(Math.floor(amountInSol * LAMPORTS_PER_SOL));
        const slippageBps = context.config.slippageBps;
        const tipAccount = new PublicKey(context.config.jitoTipAccountPubkey);

        // 1. Получаем ATA и проверяем существование
        const ataAddress = getAssociatedTokenAddressSync(
            mintPublicKey, tradingWalletKp.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
        );
        logger.debug({ mint: coin.mint, ata: ataAddress.toBase58() }, "Calculated ATA address");

        // 2. Получаем данные кривой связывания с повторными попытками для "not found"
        logger.debug({ mint: coin.mint }, `Fetching bonding curve data (max ${BONDING_CURVE_FETCH_RETRIES} retries)...`);
        let bondingCurveData: BondingCurveAccount | null = null;
        let lastFetchError: any = null;

        for (let attempt = 1; attempt <= BONDING_CURVE_FETCH_RETRIES; attempt++) {
            try {
                logger.trace({ mint: coin.mint, attempt }, "Attempting to fetch bonding curve data...");
                bondingCurveData = await rpcWithRetry(
                   () => pumpFunProgram.account.bondingCurve.fetch(bondingCurvePublicKey, 'processed'),
                   `fetchBC attempt ${attempt} (${bondingCurvePublicKey.toBase58()})`
                );
                if (bondingCurveData) {
                    logger.trace({ mint: coin.mint, attempt, bondingCurveData }, "Successfully fetched bonding curve data.");
                    lastFetchError = null; 
                    break; // Успех, выходим из цикла
                } else {
                     // Маловероятно, но обработаем
                     logger.warn({ mint: coin.mint, attempt }, "Fetched bonding curve data but it was null/undefined. This is unexpected. Retrying...");
                     lastFetchError = new Error("Fetched bonding curve data but it was null/undefined.");
                     // Явно сбрасываем bondingCurveData на всякий случай
                     bondingCurveData = null; 
                     // Переходим к задержке перед следующей попыткой
                }
            } catch (fetchError: any) {
                lastFetchError = fetchError; 
                const errorString = String(fetchError?.message || fetchError).toLowerCase();
                const isNotFoundError = errorString.includes("account does not exist") ||
                                         errorString.includes("account not found") ||
                                         errorString.includes("could not find account");

                if (isNotFoundError && attempt < BONDING_CURVE_FETCH_RETRIES) {
                    logger.warn({ mint: coin.mint, attempt, error: fetchError.message }, `Bonding curve not found, retrying in ${BONDING_CURVE_FETCH_DELAY_MS}ms...`);
                    await new Promise(resolve => setTimeout(resolve, BONDING_CURVE_FETCH_DELAY_MS));
                    continue; // <<<--- Ключевое изменение: ПРОДОЛЖАЕМ цикл для следующей попытки
                } else {
                    logger.error({ mint: coin.mint, attempt, error: fetchError.message }, "Failed to fetch bonding curve data due to non-recoverable error or max retries reached.");
                    bondingCurveData = null; // Убедимся, что данные не используются
                    break; // Выходим из цикла при неисправимой ошибке или исчерпании попыток
                }
            }
             // Если мы дошли сюда (не через break), значит была ошибка 'null/undefined' 
             // или это последняя попытка 'not found' без break выше. Ждем перед ретраем.
             if (attempt < BONDING_CURVE_FETCH_RETRIES) {
                  logger.warn({ mint: coin.mint, attempt }, `Waiting ${BONDING_CURVE_FETCH_DELAY_MS}ms before next fetch attempt...`);
                  await new Promise(resolve => setTimeout(resolve, BONDING_CURVE_FETCH_DELAY_MS));
             }
        }

        // Проверяем, были ли данные успешно получены ПОСЛЕ ЦИКЛА
        if (!bondingCurveData) {
            logger.error({ mint: coin.mint, error: lastFetchError?.message || "Unknown Error" }, "Failed to fetch bonding curve data after all retries. Aborting buy.");
            coin.buyError = `Failed to fetch bonding curve: ${lastFetchError?.message || "Retries exceeded"}`;
            coin.state = 'failed'; 
            await recordTradeStats(coin, context); 
            context.activeCoin = null; 
            return false; // <<<--- Гарантированный выход, если данные не получены
        }
        // Если мы здесь, bondingCurveData точно не null
        logger.trace({ mint: coin.mint, bondingCurveData }, "Fetched bonding curve data successfully.");

        // 3. Рассчитываем параметры для вызова buy (теперь ТОЛЬКО с валидными bondingCurveData)
        const virtualSolReserves = bondingCurveData.virtualSolReserves; // Тип BN из IDL
        const virtualTokenReserves = bondingCurveData.virtualTokenReserves; // Тип BN из IDL
        const amountInLamportsBN = new BN(amountInLamportsBigInt.toString());

        if (virtualSolReserves.isZero() || virtualTokenReserves.isZero()) {
             logger.error({ mint: coin.mint, vsr: virtualSolReserves.toString(), vtr: virtualTokenReserves.toString() }, "Cannot calculate buy params: bonding curve reserves are zero.");
             throw new Error("Cannot calculate buy params: bonding curve reserves are zero.");
        }
        const expectedTokensOutBN = virtualTokenReserves.mul(amountInLamportsBN).div(virtualSolReserves.add(amountInLamportsBN));
        const maxSolCostBN = amountInLamportsBN;
        const slippageNumerator = new BN(10000).sub(new BN(slippageBps));
        const slippageDenominator = new BN(10000);
        const minTokenAmountBN = expectedTokensOutBN.mul(slippageNumerator).div(slippageDenominator);

        logger.info({
            mint: coin.mint, amountInSol: amountInSol,
            expectedTokensOut: expectedTokensOutBN.toString(), slippageBps: slippageBps,
            minTokenAmountOut: minTokenAmountBN.toString(), maxSolCost: maxSolCostBN.toString()
        }, "Calculated buy parameters with slippage");

        // <<<--- Получаем ПРАВИЛЬНЫЙ АТА для кривой бондинга --- >>>
        const associatedBondingCurveAddress = getAssociatedTokenAddressSync(
            mintPublicKey, 
            bondingCurvePublicKey, // <<<--- Владелец - кривая бондинга!
            true, // <<<--- Ставим true, так как это PDA-аккаунт
            TOKEN_PROGRAM_ID, 
            ASSOCIATED_TOKEN_PROGRAM_ID
        );

        // 4. Формируем инструкцию покупки с .accountsStrict() и camelCase
        logger.debug({ mint: coin.mint }, "Building buy instruction with Anchor...");
        let buyInstruction: TransactionInstruction;
        try {
            buyInstruction = await pumpFunProgram.methods
                .buy( minTokenAmountBN, maxSolCostBN )
                .accountsStrict({
                    global: GLOBAL_ACCOUNT_PUBKEY,
                    feeRecipient: FEE_RECIPIENT_PUBKEY,
                    mint: mintPublicKey,
                    bondingCurve: bondingCurvePublicKey,
                    associatedBondingCurve: associatedBondingCurveAddress,
                    associatedUser: ataAddress, 
                    user: tradingWalletKp.publicKey,
                    systemProgram: SYSTEM_PROGRAM_ID,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    rent: SYSVAR_RENT_PUBKEY,
                    eventAuthority: PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], context.pumpFunProgram.programId)[0],
                    program: context.pumpFunProgram.programId,
                })
                .instruction();
             logger.trace({ mint: coin.mint, buyIxData: buyInstruction.data.toString('hex') }, "Built buy instruction");
        } catch (buildError: any) {
             logger.error({ mint: coin.mint, error: buildError.message, stack: buildError.stack }, "Failed to build Anchor buy instruction.");
             throw buildError;
        }

        // 5. Compute Units и Jito Tip
        let unitsConsumed = context.config.defaultComputeUnits;
        // <<<--- Используем фиксированное значение --- >>>
        const tipLamports = context.config.jitoFixedTipLamports;
        logger.debug({ mint: coin.mint, units: unitsConsumed, fixedTip: tipLamports }, "Using fixed Jito tip");

        // 6. Сборка транзакции
        const mainTx = new Transaction();
        mainTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: unitsConsumed }));
        // Всегда добавляем инструкцию создания ATA (она идемпотентна)
        mainTx.add(createAssociatedTokenAccountInstruction(tradingWalletKp.publicKey, ataAddress, tradingWalletKp.publicKey, mintPublicKey, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
        mainTx.add(buyInstruction);
        // <<<--- Используем фиксированное значение --- >>>
        mainTx.add(SystemProgram.transfer({ 
            fromPubkey: tradingWalletKp.publicKey, 
            toPubkey: tipAccount, 
            lamports: BigInt(tipLamports) // Используем новое значение
        }));
        mainTx.recentBlockhash = context.latestBlockhash;
        mainTx.feePayer = tradingWalletKp.publicKey;
        
        mainTx.sign(tradingWalletKp);
        const serializedMainTx = bs58.encode(mainTx.serialize({ requireAllSignatures: false }));

        // 7. Отправка Jito бандла через gRPC (ОДНОЙ транзакции)
        logger.info({ mint: coin.mint }, "Sending Jito bundle via gRPC (single tx with tip)...");
        let buySignature: string | null = bs58.encode(mainTx.signature!);
        try { 
            // Создаем объект Bundle из транзакции
            const txBuffer = mainTx.serialize({ requireAllSignatures: false });
            const versioned = VersionedTransaction.deserialize(txBuffer);
            const bundle = new Bundle([versioned], 5); // Лимит в 5 транзакций для бандла
            
            // Отправляем бандл через gRPC клиент
            const resultSend = await context.jitoClient.sendBundle(bundle);
            
            if ('ok' in resultSend && resultSend.ok === false) {
                const error = resultSend.error;
                // Более детальная обработка ошибок gRPC
                logger.error({ 
                    mint: coin.mint, 
                    error: error.message,
                    errorCode: error.code,
                    errorDetails: error.details
                }, "Failed to send Jito bundle via gRPC (detailed)");
                throw new Error(`Failed to send Jito bundle via gRPC: ${error.message}, code: ${error.code}, details: ${error.details}`);
            }
            
            const bundleId = resultSend.value;
            logger.info({ mint: coin.mint, bundleId }, "Jito bundle sent via gRPC successfully.");
        } catch (gRpcError: any) { 
             const errorMsg = gRpcError.message || "Unknown gRPC error";
             logger.error({ mint: coin.mint, error: errorMsg }, "Failed to send Jito bundle via gRPC.");
             coin.buyError = `Jito gRPC Error: ${errorMsg}`;
             coin.state = 'failed';
             await recordTradeStats(coin, context);
             context.activeCoin = null;
             return false;
        }
        
        if (!buySignature) {
             logger.error({ mint: coin.mint }, "Failed to retrieve transaction signature after sending bundle (unexpected). Aborting buy.");
             coin.buyError = "Failed to retrieve signature post-bundle";
             coin.state = 'failed'; 
             await recordTradeStats(coin, context);
             context.activeCoin = null;
             return false;
        }

        // 8. Ожидание подтверждения
        logger.info({ mint: coin.mint, signature: buySignature }, "Waiting for BUY transaction confirmation...");
        const confirmed = await waitForTransactionConfirmation(buySignature, connection, 'processed', 90);
        if (!confirmed) {
            logger.warn({ mint: coin.mint, signature: buySignature }, "BUY transaction confirmation failed or timed out ('processed').");
            try {
                const txDetails = await connection.getTransaction(buySignature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                logger.warn({ mint: coin.mint, signature: buySignature, txDetails }, "Transaction details (if available after timeout)");
                coin.buyError = `Confirmation timeout ('processed'). Details: ${JSON.stringify(txDetails?.meta?.err || 'N/A')}`;
            } catch (detailError: any) {
                 logger.error({ mint: coin.mint, signature: buySignature, error: detailError.message }, "Failed to get transaction details after confirmation timeout ('processed').");
                 coin.buyError = "Confirmation timeout ('processed'), failed to get details ('confirmed').";
            }
            coin.state = 'failed'; 
            await recordTradeStats(coin, context);
            context.activeCoin = null;
            return false; 
        }

        // 9. Успешная покупка
        coin.buyTxSignature = buySignature;
        coin.state = 'tracking';

        // <<<--- Добавляем цикл повторных попыток для получения баланса --- >>>
        const BALANCE_FETCH_RETRIES = 5; // Макс. попыток
        const BALANCE_RETRY_DELAY_MS = 300; // Пауза между попытками
        let balanceFetched = false;
        logger.debug({ mint: coin.mint, ata: ataAddress.toBase58() }, `Fetching token balance (max ${BALANCE_FETCH_RETRIES} retries)...`);

        for (let attempt = 1; attempt <= BALANCE_FETCH_RETRIES; attempt++) {
            try {
                logger.trace({ mint: coin.mint, attempt }, `Attempt ${attempt} to fetch token balance...`);
                const tokenBalanceResponse = await rpcWithRetry(
                    () => connection.getTokenAccountBalance(ataAddress, 'processed'),
                    `getTokenBalance attempt ${attempt} (${ataAddress.toBase58()})`
                );

                // Проверяем, что amount существует и не null/undefined
                if (tokenBalanceResponse?.value?.amount !== null && tokenBalanceResponse?.value?.amount !== undefined) {
                    coin.tokensHeld = tokenBalanceResponse.value.amount;
                    logger.info({ mint: coin.mint, balance: coin.tokensHeld }, "Token balance fetched successfully.");
                    balanceFetched = true;
                    break; // Успех, выходим из цикла
                } else {
                    logger.warn({ mint: coin.mint, attempt, response: tokenBalanceResponse }, `Attempt ${attempt}: Could not retrieve token balance amount ('processed'), retrying...`);
                }
            } catch (balanceError: any) {
                logger.warn({ 
                    mint: coin.mint, 
                    attempt,
                    ata: ataAddress.toBase58(), 
                    error: balanceError.message 
                }, `Attempt ${attempt}: Failed to fetch token balance ('processed'), retrying...`);
                 // Не выходим из цикла, пробуем снова
            }
            
            // Если не вышли из цикла (т.е. не было break), ждем перед следующей попыткой
            if (attempt < BALANCE_FETCH_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, BALANCE_RETRY_DELAY_MS));
            }
        }

        // Если после всех попыток баланс не получен, ставим UNKNOWN
        if (!balanceFetched) {
             logger.error({ mint: coin.mint, attempts: BALANCE_FETCH_RETRIES }, "Failed to fetch token balance after all retries. Setting to UNKNOWN.");
             coin.tokensHeld = 'UNKNOWN'; 
        }
        // --- >>> Баланс получен (или помечен как неизвестный) <<< ---

        logger.info({ mint: coin.mint, sig: coin.buyTxSignature, tokensHeld: coin.tokensHeld }, 'BUY successful (Anchor)!');
        await startActiveCoinTracking(coin, context);
        return true;

    } catch (error) {
        // ... (обработка ошибок) ...
         return false;
    }
}

// <<<--- Реализуем Функцию Проверки Условий Продажи --- >>>
/**
 * Проверяет условия для продажи активной монеты.
 */
async function checkSellConditions(coin: CoinPosition, context: BotContext): Promise<void> {
    logger.trace({ mint: coin.mint, state: coin.state }, "Checking sell conditions...");

    if (coin.state === 'selling' || coin.state === 'sold' || coin.state === 'failed') {
        return;
    }

    if (coin.currentMarketCap === undefined || coin.initialMarketCap === undefined || !coin.lastMarketCapUpdateTime) {
        logger.warn({ mint: coin.mint }, "Skipping sell check due to missing market cap data.");
        return;
    }

    const config = context.config;
    const currentMarketCap = coin.currentMarketCap;
    const initialMarketCap = coin.initialMarketCap;
    const maxMarketCap = coin.maxMarketCap || initialMarketCap;

    let sellReason: string | null = null;
    let sellAmountPercentage: number | 'ALL' = 'ALL';

    // Проверка Условий
    if (coin.creatorSold) { // TODO: Отслеживание продаж создателя пока не реализовано
        // sellReason = `Creator sell detected`; 
        // sellAmountPercentage = 'ALL';
    } else if (currentMarketCap < initialMarketCap * (1 - config.entrySlPct / 100)) {
        sellReason = `Entry SL hit (${config.entrySlPct}%)`;
    } else if (currentMarketCap < maxMarketCap * (1 - config.maxMcSlPct / 100)) {
        sellReason = `Max MC SL hit (${config.maxMcSlPct}%)`;
    } else if (coin.maxMarketCapUpdateTime && (Date.now() - coin.maxMarketCapUpdateTime.getTime() > config.stagnationTimeoutSec * 1000)) {
        // Сработает, если прошло больше stagnationTimeoutSec секунд с тех пор, как был зафиксирован последний maxMarketCap
        sellReason = `Stagnation Timeout (No new Max MC for ${config.stagnationTimeoutSec}s)`;
    } else if (!coin.soldTp2 && currentMarketCap >= initialMarketCap * config.tp2McMult) {
        sellReason = `TP2 hit (>= ${config.tp2McMult}x)`;
        coin.soldTp2 = true;
        sellAmountPercentage = 'ALL';
    } else if (!coin.soldTp1 && currentMarketCap >= initialMarketCap * config.tp1McMult) {
        sellReason = `TP1 hit (>= ${config.tp1McMult}x)`;
        coin.soldTp1 = true;
        sellAmountPercentage = config.tp1SellPct;
    }

    if (sellReason) {
        logger.info({ 
            mint: coin.mint, 
            reason: sellReason, 
            currentMC: currentMarketCap, 
            initialMC: initialMarketCap,
            maxMC: maxMarketCap,
            sellPercentage: sellAmountPercentage
        }, `Sell condition met! Attempting sell.`);
        
        // <<<--- Сохраняем причину продажи ПЕРЕД вызовом executeSell --- >>>
        coin.sellReason = sellReason; 
        coin.state = 'selling'; 
        executeSell(coin, context, sellAmountPercentage).catch(err => {
             logger.error({ mint: coin.mint, error: err }, "executeSell promise rejected unexpectedly");
             // Попытаемся вернуть состояние, если executeSell не смог этого сделать
             if(coin.state === 'selling') coin.state = 'tracking'; 
        }); 
    }
}

/**
 * Запускает периодическое отслеживание Market Cap для активной монеты.
 */
async function startActiveCoinTracking(coin: CoinPosition, context: BotContext): Promise<void> {
    logger.info({ mint: coin.mint }, 'Starting active tracking...');

    if (context.trackingIntervalId) {
        clearInterval(context.trackingIntervalId);
        context.trackingIntervalId = null;
    }

    const bondingCurvePublicKey = new PublicKey(coin.bondingCurve);
    const connection = context.solanaConnection;
    const pumpFunProgram = context.pumpFunProgram; // Тип Program<Pump>

    const fetchAndUpdateMC = async () => {
        // <<<--- Лог в начале интервала --- >>>
        logger.trace({ mint: coin.mint, state: coin.state }, "fetchAndUpdateMC interval triggered"); 
        
        if (context.activeCoin?.mint !== coin.mint || (coin.state !== 'tracking' && coin.state !== 'buying')) { // Allow fetch during 'buying' state initially
             logger.warn({ expectedMint: coin.mint, actualMint: context.activeCoin?.mint, state: coin.state}, 'Stopping tracking or pre-fetch for inactive/changed/sold coin.');
             if(context.trackingIntervalId) clearInterval(context.trackingIntervalId);
             context.trackingIntervalId = null;
             return;
        }
                
        try {
            const ataAddress = getAssociatedTokenAddressSync(new PublicKey(coin.mint), context.tradingWallet.publicKey);
            
            // <<<--- Параллельно получаем данные кривой и баланс ('confirmed') --- >>>
            logger.trace({ mint: coin.mint }, "Fetching curve data and balance concurrently...");
            const [curveAccountInfoResult, balanceResponseResult] = await Promise.allSettled([
                rpcWithRetry(
                    () => pumpFunProgram.account.bondingCurve.fetch(bondingCurvePublicKey, 'confirmed'),
                    `fetchBC_track(${bondingCurvePublicKey.toBase58()})`
                ),
                rpcWithRetry(
                    () => connection.getTokenAccountBalance(ataAddress, 'confirmed'),
                    `getTokenBalance_track(${ataAddress.toBase58()})`
                )
            ]);

            const now = new Date();
            let curveDataFetched = false;
            let balanceFetched = false;

            // Обработка результата данных кривой
            if (curveAccountInfoResult.status === 'fulfilled' && curveAccountInfoResult.value) {
                const curveAccountInfo = curveAccountInfoResult.value as BondingCurveAccount; // Приводим тип
                coin.lastKnownCurveData = curveAccountInfo; // Сохраняем данные кривой
                coin.lastCurveDataFetchTime = now;
                curveDataFetched = true;
                logger.trace({ mint: coin.mint }, "Fetched bonding curve data for MC update and pre-fetch."); 
                
                // <<< Расчет Market Cap перенесен внутрь этой проверки >>>
                 const decodedData: BondingCurveAccount = curveAccountInfo; // Используем уже полученные данные
                 const bondingCurveData: BondingCurveData = {
                     virtualTokenReserves: decodedData.virtualTokenReserves,
                     virtualSolReserves: decodedData.virtualSolReserves,
                     realTokenReserves: decodedData.realTokenReserves,
                     realSolReserves: decodedData.realSolReserves,
                     tokenTotalSupply: decodedData.tokenTotalSupply,
                     complete: decodedData.complete
                 };
                 if (bondingCurveData.virtualTokenReserves.gtn(0) && bondingCurveData.virtualSolReserves.gtn(0) && bondingCurveData.tokenTotalSupply?.gtn(0)) {
                    const marketCapLamportsBN = bondingCurveData.tokenTotalSupply.mul(bondingCurveData.virtualSolReserves).div(bondingCurveData.virtualTokenReserves);
                    const marketCapDecimal = new Decimal(marketCapLamportsBN.toString()).div(LAMPORTS_PER_SOL);
                    const currentMarketCapNumber = marketCapDecimal.toNumber(); 
                    
                    logger.info({ 
                        mint: coin.mint, 
                        currentMarketCap: marketCapDecimal.toString(),
                        previousMarketCap: coin.currentMarketCap ?? 'N/A',
                        maxMarketCap: (coin.maxMarketCap || coin.initialMarketCap) ?? 'N/A'
                    }, 'Market Cap updated.'); 

                    // Обновляем данные монеты (храним как number)
                    coin.currentMarketCap = currentMarketCapNumber;
                    coin.lastMarketCapUpdateTime = now; // Используем общее время `now`
                    if (!coin.initialMarketCap) {
                        coin.initialMarketCap = currentMarketCapNumber;
                        coin.maxMarketCap = currentMarketCapNumber; // <<< Инициализируем maxMarketCap
                        coin.maxMarketCapUpdateTime = now;      // <<< Инициализируем время обновления максимума
                    } else if (currentMarketCapNumber > (coin.maxMarketCap || 0)) { // <<< Проверяем новый максимум
                         coin.maxMarketCap = currentMarketCapNumber;
                         coin.maxMarketCapUpdateTime = now;     // <<< Обновляем время при новом максимуме
                    }
                } else {
                     logger.warn({ mint: coin.mint }, "Cannot calculate Market Cap: bonding curve reserves are zero.");
                }
                 // <<< Конец расчета Market Cap >>>

            } else {
                 logger.warn({ mint: coin.mint, error: (curveAccountInfoResult as PromiseRejectedResult).reason }, "Could not fetch bonding curve data for tracking/pre-fetch.");
                 // Не сбрасываем старые данные, если они есть
            }

            // Обработка результата баланса
            if (balanceResponseResult.status === 'fulfilled' && balanceResponseResult.value?.value?.amount !== null && balanceResponseResult.value?.value?.amount !== undefined) {
                coin.lastKnownBalance = balanceResponseResult.value.value.amount; // Сохраняем баланс
                coin.lastBalanceFetchTime = now;
                balanceFetched = true;
                logger.trace({ mint: coin.mint, balance: coin.lastKnownBalance }, "Fetched token balance for pre-fetch.");
            } else {
                const errorReason = balanceResponseResult.status === 'rejected' ? (balanceResponseResult as PromiseRejectedResult).reason : "Amount is null/undefined";
                logger.warn({ mint: coin.mint, error: errorReason }, "Could not fetch token balance for pre-fetch.");
                // Не сбрасываем старый баланс, если он есть
            }
            // <<<--- Конец параллельной загрузки и обработки --- >>>

            // <<<--- Проверяем условия продажи ТОЛЬКО если есть свежие данные кривой --- >>>
            if (curveDataFetched && coin.state === 'tracking') { // Check conditions only if in tracking state
                await checkSellConditions(coin, context);
            }

        } catch (error: any) {
             const errorDetails = error instanceof Error ? { message: error.message, stack: error.stack, name: error.name } : { errorInfo: error };
             logger.error({ mint: coin.mint, error: errorDetails }, "Error during Market Cap tracking interval.");
        }
    };

    // Initial fetch might happen quickly after buy, ensure ATA exists potentially
    await new Promise(resolve => setTimeout(resolve, 500)); // Small delay before first fetch
    await fetchAndUpdateMC(); // Первый вызов для получения данных
    context.trackingIntervalId = setInterval(fetchAndUpdateMC, context.config.mcCheckIntervalMs); // Запуск интервала

    logger.warn({ mint: coin.mint }, "Creator sell tracking not implemented yet.");
}

/**
 * Выполняет продажу токенов с использованием Anchor.
 */
export async function executeSell(
    coin: CoinPosition, 
    context: BotContext, 
    amountPercentage: number | 'ALL',
    isShutdown: boolean = false
): Promise<boolean> {
     logger.info({ mint: coin.mint, amountPercentage, reason: coin.sellReason, isShutdown }, "Attempting sell (Anchor)...");
     coin.state = 'selling';
     try {
         const tradingWalletKp = context.tradingWallet;
         const mintPublicKey = new PublicKey(coin.mint);
         const bondingCurvePublicKey = new PublicKey(coin.bondingCurve);
         const connection = context.solanaConnection;
         const pumpFunProgram = context.pumpFunProgram;
         const slippageBps = context.config.slippageBps;
         const tipAccount = new PublicKey(context.config.jitoTipAccountPubkey);
         const ataAddress = getAssociatedTokenAddressSync(mintPublicKey, tradingWalletKp.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

         // <<<--- ИЗМЕНЕНИЕ: Используем кешированные данные вместо RPC-запросов --- >>>
         // 1. Проверка наличия кешированного баланса
         if (coin.lastKnownBalance === undefined || coin.lastKnownBalance === null || !coin.lastBalanceFetchTime) {
             logger.error({ mint: coin.mint }, "Cannot execute sell: lastKnownBalance is missing. Aborting sell.");
             coin.sellError = "Missing cached balance before sell";
             coin.state = 'tracking'; // Возвращаем в отслеживание, возможно, данные появятся позже
             return false;
         }
         // Проверка свежести данных (опционально, но рекомендуется)
         const balanceAgeMs = Date.now() - coin.lastBalanceFetchTime.getTime();
         if (balanceAgeMs > context.config.mcCheckIntervalMs * 2.5) { // Если данные старше ~2.5 интервалов
             logger.warn({ mint: coin.mint, ageMs: balanceAgeMs }, "Cached balance is potentially too old. Consider aborting or increase fetch frequency.");
             // Можно добавить return false; здесь для большей безопасности
         }
         logger.debug({ mint: coin.mint, balance: coin.lastKnownBalance, ageMs: balanceAgeMs }, "Using cached token balance for sell.");
         coin.tokensHeld = coin.lastKnownBalance; // Обновляем на всякий случай
         const currentTokensHeldBigInt = BigInt(coin.lastKnownBalance);

         // 2. Проверка наличия кешированных данных кривой
         if (!coin.lastKnownCurveData || !coin.lastCurveDataFetchTime) {
            logger.error({ mint: coin.mint }, "Cannot execute sell: lastKnownCurveData is missing. Aborting sell.");
            coin.sellError = "Missing cached curve data before sell";
            coin.state = 'tracking'; 
            return false;
        }
        const curveDataAgeMs = Date.now() - coin.lastCurveDataFetchTime.getTime();
        if (curveDataAgeMs > context.config.mcCheckIntervalMs * 2.5) { // Если данные старше ~2.5 интервалов
             logger.warn({ mint: coin.mint, ageMs: curveDataAgeMs }, "Cached curve data is potentially too old. Consider aborting or increase fetch frequency.");
            // Можно добавить return false; здесь для большей безопасности
        }
        logger.debug({ mint: coin.mint, ageMs: curveDataAgeMs }, "Using cached bonding curve data for sell.");
        // Приводим тип сохраненных данных
        const bondingCurveData = coin.lastKnownCurveData as BondingCurveAccount; 

        // 3. Расчеты с использованием кешированных данных
         if (currentTokensHeldBigInt === 0n) { 
             logger.info({ mint: coin.mint }, "Cached token balance is zero. Considering sell successful (no-op)."); 
             coin.state = 'sold'; 
             await recordTradeStats(coin, context); 
             if (context.activeCoin?.mint === coin.mint) context.activeCoin = null; // <<< Убедимся, что обнуляем
             return true; 
         }

         // Расчет количества для продажи (без изменений)
         let tokensToSellBigInt: bigint;
         if (amountPercentage === 'ALL') {
             tokensToSellBigInt = currentTokensHeldBigInt;
         } else {
             const sellPct = BigInt(Math.max(0, Math.min(100, amountPercentage)));
             tokensToSellBigInt = (currentTokensHeldBigInt * sellPct) / 100n;
             logger.warn({ mint: coin.mint }, "Partial sell percentage logic triggered.");
         }
          if (tokensToSellBigInt <= 0n) { 
             logger.warn({ mint: coin.mint, amountToSell: tokensToSellBigInt.toString(), percentage: amountPercentage }, "Calculated amount to sell is zero or negative. Skipping sell.");
             coin.state = 'tracking'; 
             return false;
         }
         const tokensToSellBN = new BN(tokensToSellBigInt.toString());
         logger.info({ mint: coin.mint, amountToSell: tokensToSellBN.toString() }, "Calculated tokens to sell (using cached balance).");

        // Расчет min SOL out (используем кешированные данные кривой)
        const virtualSolReserves = bondingCurveData.virtualSolReserves;
        const virtualTokenReserves = bondingCurveData.virtualTokenReserves;
        if (virtualTokenReserves.isZero()) { 
             logger.error({ mint: coin.mint, vtr: virtualTokenReserves.toString() }, "Cannot calculate sell params (cached): virtual token reserves are zero.");
             coin.sellError = "Zero virtual token reserves (Cached Sell)";
             coin.state = 'tracking'; 
             return false; 
        }
        const solOutBN = virtualSolReserves.mul(tokensToSellBN).div(virtualTokenReserves.add(tokensToSellBN));
        const slippageNumerator = new BN(10000).sub(new BN(slippageBps));
        const slippageDenominator = new BN(10000);
        const minSolOutputBN = solOutBN.mul(slippageNumerator).div(slippageDenominator);
        logger.info({ mint: coin.mint, expectedSolOut: solOutBN.toString(), minSolOutput: minSolOutputBN.toString() }, "Calculated minimum SOL output (using cached curve data)"); 

        // <<<--- КОНЕЦ ИЗМЕНЕНИЯ: Далее идет построение транзакции --- >>>

        // Получаем ПРАВИЛЬНЫЙ АТА для кривой бондинга (без изменений)
        const associatedBondingCurveAddress = getAssociatedTokenAddressSync(
            mintPublicKey, 
            bondingCurvePublicKey, 
            true, 
            TOKEN_PROGRAM_ID, 
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        logger.trace({ mint: coin.mint, associatedBondingCurve: associatedBondingCurveAddress.toBase58() }, "Calculated Associated Bonding Curve address (PDA) for sell");

         // 4. Формирование инструкции sell с .accountsStrict() и camelCase
         logger.debug({ mint: coin.mint }, "Building sell instruction (Anchor)...");
         let sellInstruction: TransactionInstruction;
         try {
             sellInstruction = await pumpFunProgram.methods
                 .sell( tokensToSellBN, minSolOutputBN )
                 .accountsStrict({
                    global: GLOBAL_ACCOUNT_PUBKEY,
                    feeRecipient: FEE_RECIPIENT_PUBKEY,
                    mint: mintPublicKey,
                    bondingCurve: bondingCurvePublicKey,
                    associatedBondingCurve: associatedBondingCurveAddress, 
                    associatedUser: ataAddress, 
                    user: tradingWalletKp.publicKey,
                    systemProgram: SYSTEM_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, 
                    tokenProgram: TOKEN_PROGRAM_ID,
                    eventAuthority: PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], context.pumpFunProgram.programId)[0],
                    program: context.pumpFunProgram.programId,
                 })
                 .instruction();
             logger.trace({ mint: coin.mint, sellIxData: sellInstruction.data.toString('hex') }, "Built sell instruction");
         } catch (buildError: any) {
              logger.error({ mint: coin.mint, error: buildError.message, stack: buildError.stack }, "Failed to build Anchor sell instruction."); 
              coin.sellError = `Build Sell Ix Error: ${buildError.message}`;
              coin.state = 'tracking'; return false;
         }

        // 5. Compute Units и Jito Tip
        const unitsConsumed = context.config.defaultComputeUnits;
        const tipLamports = context.config.jitoFixedTipLamports;
        logger.debug({ mint: coin.mint, units: unitsConsumed, fixedTip: tipLamports }, "Using fixed Jito tip for sell");

        // 6. Сборка транзакции
        const finalSellTx = new Transaction();
        finalSellTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: unitsConsumed }));
        finalSellTx.add(sellInstruction);
        finalSellTx.add(SystemProgram.transfer({fromPubkey: tradingWalletKp.publicKey, toPubkey: tipAccount, lamports: BigInt(tipLamports) }));
        finalSellTx.recentBlockhash = context.latestBlockhash;
        finalSellTx.feePayer = tradingWalletKp.publicKey;
        finalSellTx.sign(tradingWalletKp);
        const rawSellTx = finalSellTx.serialize();

        // 7. Отправка Jito бандла через gRPC
        logger.info({ mint: coin.mint }, "Sending Jito SELL bundle via gRPC...");
        let sellSignature: string | null = null;
        try { 
            // Получаем подпись транзакции перед отправкой
            sellSignature = bs58.encode(finalSellTx.signatures.find(s => s.publicKey.equals(tradingWalletKp.publicKey))!.signature!);
            
            // Создаем объект Bundle из транзакции
            const txBuffer = finalSellTx.serialize();
            const versioned = VersionedTransaction.deserialize(txBuffer);
            const bundle = new Bundle([versioned], 5); // Лимит в 5 транзакций для бандла
            
            // Отправляем бандл через gRPC клиент
            const resultSend = await context.jitoClient.sendBundle(bundle);
            
            if ('ok' in resultSend && resultSend.ok === false) {
                const error = resultSend.error;
                // Более детальная обработка ошибок gRPC
                logger.error({ 
                    mint: coin.mint, 
                    error: error.message,
                    errorCode: error.code,
                    errorDetails: error.details
                }, "Failed to send Jito SELL bundle via gRPC (detailed)");
                throw new Error(`Failed to send Jito SELL bundle via gRPC: ${error.message}, code: ${error.code}, details: ${error.details}`);
            }
            
            const bundleId = resultSend.value;
            logger.info({ mint: coin.mint, bundleId }, "Jito SELL bundle sent via gRPC successfully.");
        } catch (gRpcError: any) { 
            const errorMsg = gRpcError.message || "Unknown gRPC error";
            logger.error({ mint: coin.mint, error: errorMsg }, "Failed to send Jito SELL bundle via gRPC.");
            coin.sellError = `Jito SELL gRPC Error: ${errorMsg}`;
            coin.state = 'tracking'; 
            return false; 
        }

        // 8. Подтверждение
        logger.info({ mint: coin.mint, signature: sellSignature }, "Waiting for SELL confirmation...");
        const sellConfirmed = await waitForTransactionConfirmation(
            sellSignature, 
            connection, 
            'processed', 
            90,
            isShutdown
        ); 
        if (!sellConfirmed) {
            logger.warn({ mint: coin.mint, signature: sellSignature, isShutdown }, `SELL transaction confirmation failed or timed out ('processed', timeout: ${isShutdown ? '30s' : '90s'}).`);
            try {
                const txDetails = await connection.getTransaction(sellSignature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                logger.warn({ mint: coin.mint, signature: sellSignature, txDetails, isShutdown }, "Transaction details (if available after SELL timeout)");
                coin.sellError = `Sell Confirmation timeout ('processed', ${isShutdown ? '30s' : '90s'}). Details: ${JSON.stringify(txDetails?.meta?.err || 'N/A')}`;
            } catch (detailError: any) {
                 logger.error({ mint: coin.mint, signature: sellSignature, error: detailError.message, isShutdown }, "Failed to get transaction details after SELL confirmation timeout ('processed').");
                 coin.sellError = `Sell Confirmation timeout ('processed', ${isShutdown ? '30s' : '90s'}), failed to get details ('confirmed').`;
            }
            coin.state = 'tracking'; 
            return false; 
        }

        // 9. Успешная продажа
        logger.info({ mint: coin.mint, sig: sellSignature, soldAmount: tokensToSellBN.toString() }, 'SELL successful (Anchor)!');
        coin.sellTxSignature = sellSignature;
         if (amountPercentage === 'ALL') {
              coin.state = 'sold';
              // <<< Убедимся, что обнуляем активную монету >>>
              if (context.activeCoin?.mint === coin.mint) {
                  context.activeCoin = null; 
              }
          } else {
             logger.warn({ mint: coin.mint }, "Partial sell executed, coin.tokensHeld might be stale.");
             const remaining = currentTokensHeldBigInt - tokensToSellBigInt;
             coin.tokensHeld = remaining.toString();
         }
         await recordTradeStats(coin, context);
         if (amountPercentage === 'ALL') {
             coin.state = 'sold';
             context.activeCoin = null; 
         } else {
             coin.state = 'tracking'; 
         }
        return true;

     } catch (error) {
         logger.error({ mint: coin.mint, error }, "Unexpected error during executeSell");
         coin.state = 'tracking'; 
         return false;
     }
 } 

/**
 * Устанавливает флаг начала завершения работы.
 */
export function signalShutdown(): void {
    logger.info("Signalling shutdown...");
    isShuttingDown = true;
}

/**
 * Возвращает текущую активную монету (если есть).
 */
export function getActiveCoin(context: BotContext): CoinPosition | null {
    return context.activeCoin;
}
