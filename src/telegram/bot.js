import { Telegraf } from 'telegraf';

import { config } from '../config.js';
import { registerTelegramCommands } from './commands.js';

export async function startTelegramBot(dependencies) {
  const { logger } = dependencies;

  if (!config.telegramBotToken || !config.telegramChatId) {
    logger.warn(
      'Telegram bot not started because TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing.'
    );
    return null;
  }

  const bot = new Telegraf(config.telegramBotToken);

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();

    if (chatId !== config.telegramChatId) {
      logger.warn({ chatId }, 'Ignoring Telegram message from unauthorized chat');
      return;
    }

    await next();
  });

  bot.catch((error, ctx) => {
    logger.error(
      {
        err: error,
        updateType: ctx.updateType,
      },
      'Telegram bot handler failed'
    );
  });

  registerTelegramCommands(bot, dependencies);

  await bot.launch();
  logger.info({ chatId: config.telegramChatId }, 'Telegram bot started');

  return {
    bot,
    async stop() {
      await bot.stop();
      logger.info('Telegram bot stopped');
    },
  };
}
