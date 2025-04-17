import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { config } from '../config/config'; // Импортируем конфигурацию

const logsDir = path.resolve(__dirname, '../../logs');

// Создаем папку logs, если она не существует
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/:/g, '-'); // Форматируем timestamp для имени файла
const logFilePath = path.join(logsDir, `bot_run_${timestamp}.log`);

const transportTargets: pino.TransportTargetOptions[] = [
  {
    target: 'pino-pretty', // Вывод в консоль с форматированием
    options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    level: config.logLevel // Уровень логирования для консоли
  }
];

if (config.logToFile) {
  transportTargets.push({
    target: 'pino/file', // Встроенный транспорт для записи в файл
    options: { destination: logFilePath, mkdir: true }, // Указываем путь к файлу
    level: config.logLevel // Уровень логирования для файла
  });
}

const logger = pino({
  level: config.logLevel || 'info', // Устанавливаем общий минимальный уровень
  transport: {
    targets: transportTargets
  },
});

export default logger; 