import {
    Connection,
    SignatureResult,
    TransactionSignature,
    Commitment,
    SignatureStatus
} from '@solana/web3.js';
import logger from './logger';

const DEFAULT_TIMEOUT_SEC = 90;
const POLLING_INTERVAL_MS = 250;

/**
 * Ожидает подтверждения транзакции с заданным таймаутом.
 * Использует polling getSignatureStatuses.
 * @param signature Сигнатура транзакции для ожидания.
 * @param connection Solana Connection.
 * @param commitment Уровень подтверждения (по умолчанию 'confirmed').
 * @param timeoutSec Таймаут ожидания в секундах.
 * @param isShutdown Флаг завершения работы.
 * @returns true, если транзакция успешно подтверждена, false в случае ошибки или таймаута.
 */
export async function waitForTransactionConfirmation(
    signature: TransactionSignature,
    connection: Connection,
    commitment: Commitment = 'confirmed',
    timeoutSec: number = DEFAULT_TIMEOUT_SEC,
    isShutdown: boolean = false
): Promise<boolean> {
    // Если это шатдаун, используем укороченный таймаут
    const actualTimeoutSec = isShutdown ? Math.min(timeoutSec, 30) : timeoutSec; // Например, макс. 30 сек при шатдауне
    const startTime = Date.now();
    const timeoutMs = actualTimeoutSec * 1000;
    logger.debug({ signature, commitment, timeoutSec: actualTimeoutSec, isShutdown }, 'Waiting for transaction confirmation...');

    let lastStatus: SignatureStatus | null | 'FETCH_ERROR' = null;

    while (Date.now() - startTime < timeoutMs) {
        let statusInfo: SignatureStatus | null = null;
        try {
            const statuses = await connection.getSignatureStatuses([signature], {
                searchTransactionHistory: false, // Искать только в свежих
            });
            statusInfo = statuses?.value?.[0];
            lastStatus = statusInfo; // Сохраняем последний полученный статус

            if (statusInfo) {
                logger.trace({ signature, statusInfo }, 'Received signature status'); // Логируем КАЖДЫЙ полученный статус
                if (statusInfo.err) {
                    logger.error({ signature, error: statusInfo.err }, 'Transaction failed confirmation (err field present)!');
                    return false; // Транзакция ТОЧНО завершилась с ошибкой
                }
                
                // Проверяем достижение нужного уровня подтверждения (ИСПРАВЛЕНО)
                let confirmed = false;
                if (commitment === 'processed') {
                    // Если ждем 'processed', любой из этих статусов подходит
                    confirmed = statusInfo.confirmationStatus === 'processed' || 
                                statusInfo.confirmationStatus === 'confirmed' || 
                                statusInfo.confirmationStatus === 'finalized';
                } else if (commitment === 'confirmed') {
                     // Если ждем 'confirmed', подходят 'confirmed' или 'finalized'
                    confirmed = statusInfo.confirmationStatus === 'confirmed' || 
                                statusInfo.confirmationStatus === 'finalized';
                } else if (commitment === 'finalized') {
                     // Если ждем 'finalized', подходит только 'finalized'
                    confirmed = statusInfo.confirmationStatus === 'finalized';
                }

                if (confirmed) {
                    logger.info({ signature, status: statusInfo.confirmationStatus, desiredCommitment: commitment }, 'Transaction confirmed!');
                    return true; // Транзакция успешно подтверждена
                }
                // Иначе (статус есть, но не достиг нужного уровня и нет ошибки) - продолжаем опрос
                logger.trace({ signature, currentStatus: statusInfo.confirmationStatus, desiredCommitment: commitment }, 'Status received, but commitment level not reached yet. Continuing poll...');

            } else {
                // Статус еще не доступен (null)
                logger.trace({ signature }, 'Signature status not yet available (null). Continuing poll...');
            }
        } catch (error) {
            lastStatus = 'FETCH_ERROR'; // Помечаем, что была ошибка получения статуса
            if (error instanceof Error && error.message.includes('Signature status not found')) {
                 logger.trace({ signature }, 'Signature status not found via getSignatureStatuses. Continuing poll...');
            } else {
                 logger.warn({ signature, error: error instanceof Error ? error.message : error }, 'Error fetching signature status. Continuing poll...');
            }
        }

        // Пауза перед следующим опросом
        await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
    }

    // Если вышли из цикла по таймауту
    logger.warn({ 
        signature, 
        timeoutSec: actualTimeoutSec, // Используем актуальный таймаут в логе
        lastStatus: lastStatus === 'FETCH_ERROR' ? 'FETCH_ERROR' : (lastStatus ?? 'Never received'),
        isShutdown // Добавим флаг в лог
    }, 'Transaction confirmation timed out!');
    return false;
} 