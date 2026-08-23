import { handleCommand as sdkHandleCommand } from '../sdk/plugin-runtime';

export async function handleCommand(user: string, username: string, command: string): Promise<string | null> {
  return sdkHandleCommand(user, username, command);
}
