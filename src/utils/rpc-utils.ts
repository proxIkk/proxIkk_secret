import logger from './logger';

const RPC_RETRY_DELAY_MS = 250;
const MAX_RPC_RETRIES = 3;

/**
 * Обертка для выполнения RPC запроса с повторными попытками.
 * @param rpcCall Асинхронная функция, выполняющая RPC вызов.
 * @param description Описание вызова для логирования.
 */
export async function rpcWithRetry<T>(
    rpcCall: () => Promise<T>,
    description: string = 'RPC call'
): Promise<T> {
    let lastError: any = null;
    for (let attempt = 1; attempt <= MAX_RPC_RETRIES; attempt++) {
        try {
            logger.trace({ attempt, description }, "Attempting RPC call...");
            const result = await rpcCall();
            // logger.trace({ attempt, description }, "RPC call successful."); // Можно раскомментировать, если нужно
            return result;
        } catch (error: any) {
            lastError = error;
            logger.warn({ attempt, description, error: error.message }, "RPC call failed. Retrying...");
            if (attempt < MAX_RPC_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, RPC_RETRY_DELAY_MS));
            } else {
                 logger.error({ description, retries: MAX_RPC_RETRIES, error: error.message }, "RPC call failed after all retries.");
            }
        }
    }
    // Если все попытки неудачны, выбрасываем последнюю ошибку
    throw lastError || new Error(`${description} failed after ${MAX_RPC_RETRIES} retries.`);
} 