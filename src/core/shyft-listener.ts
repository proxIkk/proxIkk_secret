import Client, {
    CommitmentLevel,
    SubscribeRequestFilterTransactions,
    SubscribeRequestAccountsDataSlice,
    SubscribeRequestFilterAccounts,
    SubscribeRequestFilterSlots,
    SubscribeRequestFilterBlocks,
    SubscribeRequestFilterBlocksMeta,
    SubscribeRequestFilterEntry,
    SubscribeRequest,
} from "@triton-one/yellowstone-grpc";
import { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
// import { Idl } from "@coral-xyz/anchor"; // Убираем, если не используется напрямую
// import { SolanaParser } from "@shyft-to/solana-transaction-parser"; // Убираем парсер инструкций
import { TransactionFormatter } from "../utils/shyft-parsing/transaction-formatter";
// import pumpFunIdl from "../idls/pump_0.1.0.json"; // Убираем IDL
// import { SolanaEventParser } from "../utils/shyft-parsing/event-parser"; // Убираем парсер событий
// import { bnLayoutFormatter } from "../utils/shyft-parsing/bn-layout-formatter"; // Убираем, если не нужен
import { BotContext, ParsedPumpCreateData } from '../types/types';
import logger from '../utils/logger';
import { handleNewMintEvent } from '../core/logic'; // <<<--- Раскомментируем импорт
import { ConfigType } from "../config/config";
import * as borsh from 'borsh';
import base58 from 'bs58';
import { Buffer } from 'buffer';

const RECONNECT_DELAY_MS = 5000; // Задержка перед переподключением в мс

// --- Убираем инициализацию парсеров ---
const PUMP_FUN_PROGRAM_ID = new PublicKey(process.env.PUMP_FUN_PROGRAM_ID || "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const TXN_FORMATTER = new TransactionFormatter();
// const PUMP_FUN_IX_PARSER = new SolanaParser([]); // Убрано
// PUMP_FUN_IX_PARSER.addParserFromIdl(PUMP_FUN_PROGRAM_ID.toBase58(), pumpFunIdl as any); // Убрано
// const PUMP_FUN_EVENT_PARSER = new SolanaEventParser([], console); // Убрано
// PUMP_FUN_EVENT_PARSER.addParserFromIdl(PUMP_FUN_PROGRAM_ID.toBase58(), pumpFunIdl as any); // Убрано

// --- Схема Borsh как ОБЪЕКТ --- 
// Определяем схему напрямую как объект
const CreateEventSchema = {
    struct: {
        discriminator: { array: { type: 'u8', len: 8 } },
        name: 'string',
        symbol: 'string',
        uri: 'string',
        mint: { array: { type: 'u8', len: 32 } },      // PublicKey как массив 32 байт
        bondingCurve: { array: { type: 'u8', len: 32 } }, // PublicKey как массив 32 байт
        user: { array: { type: 'u8', len: 32 } }        // PublicKey как массив 32 байт
    }
};

// --- Функция парсинга транзакции через логи (ОБНОВЛЕННАЯ)---
function decodeAndParsePumpFunTxnFromLogs(txData: any, blockTimestampMs: number): ParsedPumpCreateData | null {
    const signature = txData.transaction?.signatures?.[0] || 'N/A';
    const creationSlot = txData.slot;
    logger.trace({ signature, extractedCreationSlot: creationSlot }, "Extracted creation slot from txData"); 

    try {
        // <<<--- Передаем blockTimestampMs в форматер, если он его использует --- >>>
        const txn = TXN_FORMATTER.formTransactionFromJson(txData.transaction, blockTimestampMs); 

        // Проверяем наличие необходимых метаданных и логов
        if (!txn.meta || txn.meta.err || !txn.meta.logMessages) {
            // Логируем только на уровне trace, если не хватает данных
            logger.trace({ signature }, 'Skipping txn due to missing meta, error, or logs');
            return null;
        }

        const logMessages = txn.meta.logMessages;
        const eventLogPrefix = 'Program data: '; // Префикс лога события Create
        const createEventDiscriminatorHex = '1b72a94ddeeb6376'; // Дискриминатор события Create

        // Итерируем по ВСЕМ логам транзакции
        for (const log of logMessages) {

            // Проверяем, начинается ли лог с префикса данных события
            if (log.startsWith(eventLogPrefix)) {
                const base64Data = log.substring(eventLogPrefix.length);
                // Логируем найденный потенциальный лог
                logger.trace({ signature, log, base64Data }, "Found potential event log ('Program data:')");

                try {
                    const dataBuffer = Buffer.from(base64Data, 'base64');

                    // Минимальная проверка длины буфера (дискриминатор + 3 ключа)
                    if (dataBuffer.length < (8 + 32 + 32 + 32)) {
                         logger.trace({ signature, log, bufferLength: dataBuffer.length }, 'Skipping potential event log: buffer too short.');
                         continue; // Переходим к следующему логу, если данных точно не хватит
                    }

                    // Извлекаем дискриминатор (первые 8 байт)
                    const logDiscriminator = dataBuffer.subarray(0, 8);
                    const actualDiscriminatorHex = logDiscriminator.toString('hex');

                    // Логируем сравнение дискриминаторов (для отладки)
                    logger.trace({
                        signature,
                        log, // Добавляем сам лог для контекста
                        expected: createEventDiscriminatorHex,
                        actual: actualDiscriminatorHex
                    }, "Comparing discriminators");

                    // Сравниваем фактический дискриминатор с ожидаемым
                    if (actualDiscriminatorHex === createEventDiscriminatorHex) {
                        // Успех! Логируем совпадение
                        logger.trace({ signature }, "Found CreateEvent discriminator match!");

                        // <<< --- Десериализуем с помощью ОБЪЕКТА СХЕМЫ --- >>>
                        const decodedEvent: any = borsh.deserialize( // Используем any для простоты
                            CreateEventSchema, // Передаем объект схемы
                            dataBuffer       // Передаем буфер
                        );

                        // Логируем результат декодирования (для отладки)
                        logger.trace({ signature, decodedEvent }, "Decoded event data");

                        // Проверяем наличие ключевых полей после декодирования
                        // Теперь поля находятся прямо в объекте decodedEvent
                        if (!decodedEvent?.mint || !decodedEvent?.bondingCurve || !decodedEvent?.user) {
                            logger.warn({ signature, log, decoded: decodedEvent }, 'Missing required fields after decoding CreateEvent. Skipping this log.');
                            continue; // Если не хватает полей, пропускаем этот лог и идем дальше
                        }

                        // Формируем стандартизированный объект с данными
                        const parsedData: ParsedPumpCreateData = {
                            signature: signature,
                            timestamp: new Date(blockTimestampMs).toISOString(), // Используем переданный timestamp
                            creationSlot: creationSlot, 
                            mint: new PublicKey(Buffer.from(decodedEvent.mint)).toBase58(),
                            bondingCurve: new PublicKey(Buffer.from(decodedEvent.bondingCurve)).toBase58(),
                            creator: new PublicKey(Buffer.from(decodedEvent.user)).toBase58(),
                            tokenName: decodedEvent.name || 'Unknown',
                            tokenSymbol: decodedEvent.symbol || 'UNK',
                            tokenUri: decodedEvent.uri || '',
                        };

                        // Логируем успешно распарсенные данные
                        logger.trace(
                            { signature: parsedData.signature, mint: parsedData.mint, creator: parsedData.creator },
                            'Parsed pump.fun CREATE event from logs'
                        );
                        // Возвращаем данные и выходим из функции (событие найдено)
                        return parsedData;
                    }
                    // Если дискриминатор не совпал, ничего не делаем, цикл продолжится к следующему логу

                } catch (decodingError) {
                    // Логируем ошибку декодирования, но НЕ прерываем цикл
                    // Это может быть лог 'Program data:' от другой программы
                    logger.error({
                        signature,
                        log,
                        error: decodingError,
                        stack: (decodingError as Error).stack // Добавляем stack trace для детальной ошибки
                    }, 'Failed to decode potential event log (borsh error), continuing search...');
                    // Продолжаем искать в других логах
                }
            } // конец if log.startsWith(eventLogPrefix)
        } // конец for...of logMessages

        // Если мы прошли весь цикл и не нашли совпадение, логируем это (уровень trace)
        logger.trace({ signature }, 'No CreateEvent found in logs for this transaction.');
        return null; // Подходящий лог не найден в этой транзакции

    } catch (error) {
        // Ловим любые другие ошибки при обработке транзакции
        logger.error({ error, signature }, 'Error processing transaction logs (outer catch)');
        return null;
    }
}

// <<<--- Добавляем функцию остановки --- >>>
let grpcStream: any = null; // Переменная для хранения стрима
let grpcClientInstance: Client | null = null; // Переменная для хранения клиента

// Модифицируем handleStream, чтобы сохранять стрим и клиент
const originalHandleStream = async (client: Client, context: BotContext, requestArgs: SubscribeRequest) => {
    grpcClientInstance = client; // Сохраняем клиент
    try {
        logger.info("handleStream: Attempting client.subscribe()...");
        const stream = await client.subscribe();
        grpcStream = stream; // Сохраняем стрим
        logger.info("handleStream: client.subscribe() successful. Stream object obtained.");

        const streamClosed = new Promise<void>((resolve, reject) => {
             stream.on("error", (error) => {
                logger.error({ error }, "Shyft gRPC stream error");
                grpcStream = null; // Сбрасываем при ошибке
                reject(error);
             });
             stream.on("end", () => {
                 logger.warn("Shyft gRPC stream ended");
                 grpcStream = null; // Сбрасываем при завершении
                 resolve();
             });
             stream.on("close", () => {
                 logger.warn("Shyft gRPC stream closed");
                 grpcStream = null; // Сбрасываем при закрытии
                 resolve();
             });
        });

        stream.on("data", async (data: any) => {
            // <<<--- УДАЛЯЕМ ИСКУССТВЕННУЮ ЗАДЕРЖКУ --- >>>
            // await new Promise(resolve => setTimeout(resolve, 10)); // Пауза 10 мс - УДАЛЕНО

            // Проверка сигнатуры для лога (оставляем)
            const signatureForLog = 
                data?.transaction?.transaction?.signatures && 
                data.transaction.transaction.signatures.length > 0
                ? data.transaction.transaction.signatures[0]
                : 'N/A';

            logger.trace({ 
                signature: signatureForLog,
                hasTransaction: !!data?.transaction 
            }, "handleStream: Received data package.");
            
            if (data?.transaction) { 
                try {
                    // <<<--- Логируем структуру data.transaction для поиска timestamp --- >>>
                    logger.trace({ transactionDataStructure: data.transaction }, "Received transaction structure");
                    
                    // <<<--- TODO: Извлечь реальный timestamp из data.transaction (например, data.transaction.blockTime) --- >>>
                    const blockTimestamp = data.transaction?.blockTime ? data.transaction.blockTime * 1000 : Date.now(); // Используем blockTime * 1000 или Date.now() как запасной вариант
                    
                    // <<<--- Результат теперь ParsedPumpCreateData --- >>>
                    const parsedEvent = decodeAndParsePumpFunTxnFromLogs(data, blockTimestamp);
                    if (parsedEvent) {
                        // <<<--- Убираем создание DetectedCoinData --- >>>
                        /* 
                        const detectedData: DetectedCoinData = {
                            ...parsedEvent, 
                            detectionSlot: context.latestSlot 
                        };
                        */
                        // <<<--- Логируем и передаем parsedEvent напрямую --- >>>
                        logger.trace({ signature: parsedEvent.signature, parsedEvent }, "Prepared data for event handler"); 
                        handleNewMintEvent(parsedEvent, context); // Передаем ParsedPumpCreateData
                    }
                } catch (parseError) {
                    logger.error({ 
                        signature: signatureForLog, // Используем безопасную сигнатуру для лога ошибки
                        error: parseError 
                    }, "Error inside stream.on('data') handler during parsing");
                }
            }
        });

        logger.info(`handleStream: Attempting stream.write() with filter: ${PUMP_FUN_PROGRAM_ID.toBase58()}`);
        await new Promise<void>((resolve, reject) => {
            stream.write(requestArgs, (err: any) => {
                if (err === null || err === undefined) {
                    logger.info("handleStream: stream.write() successful (Subscribed!).");
                    resolve();
                } else {
                    logger.error({ err }, "handleStream: stream.write() FAILED.");
                    reject(err);
                }
            });
        }).catch((reason) => {
            logger.error({ reason }, 'handleStream: stream.write() promise rejected.');
            throw reason;
        });
        logger.info("handleStream: Waiting for stream events or closure...");
        await streamClosed;
        logger.info("handleStream: streamClosed promise resolved.");

    } catch (handleStreamError) {
        logger.error({ error: handleStreamError }, "Error directly inside handleStream function");
        grpcStream = null; // Сбрасываем при ошибке
        throw handleStreamError;
    }
};

// Модифицируем startShyftListener, чтобы использовать обернутый handleStream и передавать client
export function startShyftListener(context: BotContext): void {
    logger.info('Starting Shyft gRPC stream listener (using yellowstone-grpc, manual log parsing)...');

    // Используем хост из конфига и добавляем https:// СНОВА
    const endpointHost = context.config.shyftGrpcEndpoint.split(':')[0]; 
    const fullEndpoint = `https://${endpointHost}`;
    logger.info(`Using Shyft gRPC endpoint: ${fullEndpoint}`); 

    const client = new Client(
        fullEndpoint, 
        context.config.shyftApiKey,
        {
            credentials: undefined,
            // <<<--- ВОЗВРАЩАЕМ АГРЕССИВНЫЕ НАСТРОЙКИ gRPC --- >>>
            grpcOptions: { 
                'grpc.keepalive_time_ms': 500, // Еще быстрее: 500 мс
                'grpc.keepalive_timeout_ms': 2000, // Сокращаем таймаут
                'grpc.http2.min_time_between_pings_ms': 3000, // Еще более частые пинги
                'grpc.http2.max_pings_without_data': 0, // Требуем ответ на пинги
                'grpc.keepalive_permit_without_calls': 1, // Разрешаем keepalive без активных вызовов
                'grpc.max_receive_message_length': 50 * 1024 * 1024, // Увеличиваем для приема больших сообщений
                'grpc.max_send_message_length': 5 * 1024 * 1024, // Настраиваем размер исходящих сообщений
                'grpc.enable_retries': 1, // Включаем автоматические повторные попытки
                'grpc.initial_reconnect_backoff_ms': 100, // Быстрое переподключение при обрыве
                'grpc.service_config_disable_resolution': 0, // Включаем резолюцию сервис-конфига
                'grpc.dns_enable_srv_queries': 1, // Включаем SRV запросы для оптимизации DNS
                'grpc.http2.stream_lookahead_bytes': 1 * 1024 * 1024, // Оптимизация буферизации для HTTP/2
                'grpc.default_compression_algorithm': 2, // Используем gzip (2)
                'grpc.default_compression_level': 3, // Уровень сжатия High (3)
            }
            // <<<--- КОНЕЦ ИЗМЕНЕНИЯ --- >>>
        }
    );

    const requestArgs: SubscribeRequest = {
        accounts: {},
        slots: {},
        transactions: {
            pumpFun: {
                vote: false,
                failed: false,
                signature: undefined,
                accountInclude: [PUMP_FUN_PROGRAM_ID.toBase58()],
                accountExclude: [],
                accountRequired: [],
            },
        },
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        accountsDataSlice: [],
        ping: undefined,
        commitment: CommitmentLevel.PROCESSED, // Используем PROCESSED для скорости
    };

    const handleStreamWrapper = () => {
         return originalHandleStream(client, context, requestArgs);
    };

    const subscribeCommand = async () => {
        logger.info('subscribeCommand: Starting loop...');
        while (true) {
            logger.info('subscribeCommand: Top of loop, calling handleStreamWrapper().'); // Вызываем обертку
            try {
                await handleStreamWrapper();
                logger.warn('subscribeCommand: handleStreamWrapper() completed without error.');
            } catch (error) {
                logger.error({ error }, "subscribeCommand: handleStreamWrapper() threw an error.");
            }
            logger.info(`subscribeCommand: Pausing for ${RECONNECT_DELAY_MS / 1000}s before reconnect attempt...`);
            await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
            logger.info('subscribeCommand: Reconnecting...');
        }
    };
    subscribeCommand().catch(error => {
        logger.fatal({ error }, "Critical error in Shyft listener loop. Exiting.");
        process.exit(1);
    });
}

/**
 * Останавливает gRPC поток Shyft.
 */
export function stopShyftListener(): void {
    if (grpcStream) {
        logger.info("Stopping Shyft gRPC stream...");
        try {
            grpcStream.cancel(); // Метод для остановки gRPC стрима
            grpcStream = null;
            logger.info("Shyft gRPC stream cancelled.");
        } catch (error) {
             logger.error({ error }, "Error cancelling Shyft gRPC stream.");
        }
    }
    // Можно также закрыть сам клиент, если это необходимо
    // if (grpcClientInstance) {
    //     grpcClientInstance.close(); 
    //     grpcClientInstance = null;
    // }
} 