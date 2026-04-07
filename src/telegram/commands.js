function formatTimestamp(value) {
  if (!value) {
    return 'n/a';
  }

  return new Date(value).toISOString();
}

function formatTaskLine(task) {
  return [
    `- ${task.title}`,
    `  id: ${task.id}`,
    `  status: ${task.status}`,
    `  priority: ${task.priority}`,
    `  created: ${formatTimestamp(task.created_at)}`,
  ].join('\n');
}

export function registerTelegramCommands(bot, dependencies) {
  const { orchestrator, logger, onKill } = dependencies;

  bot.start(async (ctx) => {
    await ctx.reply(
      'LocalClaw bot is connected.\nCommands: /status /pause /resume /tasks /add /kill'
    );
  });

  bot.command('status', async (ctx) => {
    const snapshot = await orchestrator.getStatusSnapshot();
    const uptimeStart = snapshot.stats?.uptime_start
      ? new Date(snapshot.stats.uptime_start).toISOString()
      : 'n/a';

    const lines = [
      `Status: ${snapshot.status}`,
      `Instance: ${snapshot.instanceId}`,
      `Poll interval: ${snapshot.pollIntervalMs} ms`,
      `Pending: ${snapshot.queue.pending_count}`,
      `In progress: ${snapshot.queue.in_progress_count}`,
      `Blocked: ${snapshot.queue.blocked_count}`,
      `Current task: ${snapshot.currentTask?.title ?? 'none'}`,
      `Completed: ${snapshot.stats?.tasks_completed ?? 0}`,
      `Failed: ${snapshot.stats?.tasks_failed ?? 0}`,
      `Uptime start: ${uptimeStart}`,
    ];

    if (snapshot.pauseReason) {
      lines.push(`Pause reason: ${snapshot.pauseReason}`);
    }

    await ctx.reply(lines.join('\n'));
  });

  bot.command('pause', async (ctx) => {
    const reason = ctx.message.text.replace(/^\/pause\s*/, '').trim() || 'Paused via Telegram';
    await orchestrator.pause(reason);
    logger.info({ reason }, 'Pause requested from Telegram');
    await ctx.reply(`LocalClaw paused.\nReason: ${reason}`);
  });

  bot.command('resume', async (ctx) => {
    await orchestrator.resume();
    logger.info('Resume requested from Telegram');
    await ctx.reply('LocalClaw resumed.');
  });

  bot.command('tasks', async (ctx) => {
    const tasks = await orchestrator.listTasks(10);

    if (tasks.length === 0) {
      await ctx.reply('No active tasks in pending, in-progress, blocked, or approval states.');
      return;
    }

    const response = tasks.map(formatTaskLine).join('\n\n');
    await ctx.reply(response);
  });

  bot.command('add', async (ctx) => {
    const description = ctx.message.text.replace(/^\/add\s*/, '').trim();

    if (!description) {
      await ctx.reply('Usage: /add <task description>');
      return;
    }

    const task = await orchestrator.createTask(description, { source: 'telegram' });
    logger.info({ taskId: task.id, title: task.title }, 'Task created from Telegram');

    await ctx.reply(
      `Task created.\nTitle: ${task.title}\nID: ${task.id}\nPriority: ${task.priority}\nStatus: ${task.status}`
    );
  });

  bot.command('kill', async (ctx) => {
    const reason = ctx.message.text.replace(/^\/kill\s*/, '').trim() || 'Killed via Telegram';
    await orchestrator.markStopped(reason);
    logger.warn({ reason }, 'Kill requested from Telegram');
    await ctx.reply(`LocalClaw stopping now.\nReason: ${reason}`);

    if (typeof onKill === 'function') {
      setTimeout(() => {
        onKill(reason).catch((error) => {
          logger.error({ err: error }, 'Kill hook failed');
        });
      }, 50);
    }
  });
}
