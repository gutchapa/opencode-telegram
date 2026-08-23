let pluginCommands: Map<string, { user: string; command: string; handler: (user: string, cmd: string, args: string) => Promise<string | null> }> = new Map();
let pluginInteractiveHandlers: Map<string, { user: string; command: string; handler: (user: string, cmd: string, args: string) => Promise<string | null> }> = new Map();
let aiHandler: ((user: string, message: string) => Promise<string | null>) | null = null;

export function registerPluginCommand(user: string, command: string, handler: (user: string, cmd: string, args: string) => Promise<string | null>): void {
  console.log(`Registering command: ${command} (user: ${user})`);
  pluginCommands.set(command.toLowerCase(), { user, command, handler });
}

export function registerPluginInteractiveHandler(user: string, command: string, handler: (user: string, cmd: string, args: string) => Promise<string | null>): void {
  pluginInteractiveHandlers.set(command.toLowerCase(), { user, command, handler });
}

export function setAiHandler(handler: (user: string, message: string) => Promise<string | null>): void {
  aiHandler = handler;
}

export async function handleCommand(user: string, username: string, command: string): Promise<string | null> {
  console.log('handleCommand called:', { user, username, command });
  const trimmed = command.trim();
  let lower = trimmed.toLowerCase();

  if (lower.startsWith('/')) {
    lower = lower.substring(1);
  }

  const cmdName = lower.split(/\s+/)[0];
  const args = trimmed.split(/\s+/).slice(1).join(' ');
  console.log('Parsed command:', cmdName, 'args:', args);
  // Telegram command menus only allow a-z0-9_, so hyphenated commands arrive
  // as underscores (e.g. /bot_help for /bot-help). Resolve both spellings.
  const resolvedCmd = pluginCommands.get(cmdName)
    ? cmdName
    : (pluginCommands.get(cmdName.replace(/_/g, '-')) ? cmdName.replace(/_/g, '-') : cmdName);
  const commandEntry = pluginCommands.get(resolvedCmd);
  console.log('Command entry found:', commandEntry);
  console.log('User match:', commandEntry && (commandEntry.user === '*' || commandEntry.user === user));
  if (commandEntry && (commandEntry.user === '*' || commandEntry.user === user)) {
    try {
      return await commandEntry.handler(user, resolvedCmd, args);
    } catch (error) {
      console.error('Error executing command:', error);
      return null;
    }
  }

  const resolvedInteractive = pluginInteractiveHandlers.get(cmdName)
    ? cmdName
    : (pluginInteractiveHandlers.get(cmdName.replace(/_/g, '-')) ? cmdName.replace(/_/g, '-') : cmdName);
  const interactiveEntry = pluginInteractiveHandlers.get(resolvedInteractive);
  if (interactiveEntry && (interactiveEntry.user === '*' || interactiveEntry.user === user)) {
    try {
      return await interactiveEntry.handler(user, resolvedInteractive, args);
    } catch (error) {
      console.error('Error executing interactive command:', error);
      return null;
    }
  }

  if (aiHandler) {
    console.log('Falling back to AI handler for:', command);
    return await aiHandler(user, command);
  }
  return null;
}

export function getRegisteredCommands(): Map<string, { user: string; command: string; handler: (user: string, cmd: string, args: string) => Promise<string | null> }> {
  return pluginCommands;
}

export function getRegisteredInteractiveHandlers(): Map<string, { user: string; command: string; handler: (user: string, cmd: string, args: string) => Promise<string | null> }> {
  return pluginInteractiveHandlers;
}

export function executePluginCommand(user: string, command: string, args: string): Promise<string | null> {
  return handleCommand(user, '', command);
}

export function matchPluginCommand(command: string): string | null {
  let cmd = command.trim().toLowerCase();
  if (cmd.startsWith('/')) {
    cmd = cmd.substring(1);
  }
  if (pluginCommands.get(cmd)) return cmd;
  const hyphenated = cmd.replace(/_/g, '-');
  return pluginCommands.get(hyphenated) ? hyphenated : null;
}
