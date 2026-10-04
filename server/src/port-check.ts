import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger.js';

const exec = promisify(execCallback);

/**
 * Check if a port is already in use and get process info
 */
export interface PortInfo {
  inUse: boolean;
  pid?: string;
  command?: string;
}

/**
 * Parse the platform's socket listing into "is something listening on `port`".
 *
 * Only a LISTENING socket whose *local* port matches counts. `netstat -ano`
 * output also carries this port as the remote end of client sockets and as
 * leftover TIME_WAIT entries; matching those made the server refuse to start
 * on a free port, reporting PID 0 ("in use by undefined").
 */
export function parsePortInfo(stdout: string, platform: string, port: number): PortInfo {
  const lines = stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean);

  if (platform === 'darwin' || platform === 'linux') {
    // lsof is already filtered to LISTEN by the caller's grep
    const parts = lines[0]?.split(/\s+/);
    return parts ? { inUse: true, pid: parts[1], command: parts[0] } : { inUse: false };
  }

  if (platform === 'win32') {
    // Proto  Local Address  Foreign Address  State  PID
    const listening = lines.find((line) => {
      const parts = line.split(/\s+/);
      const [, local, , state] = parts;
      return state === 'LISTENING' && local?.endsWith(`:${port}`);
    });
    if (!listening) return { inUse: false };

    const pid = listening.split(/\s+/).pop();
    return { inUse: true, pid: pid && pid !== '0' ? pid : undefined };
  }

  return { inUse: false };
}

async function getPortInfo(port: number): Promise<PortInfo> {
  const platform = process.platform;
  let command: string;

  if (platform === 'darwin' || platform === 'linux') {
    command = `lsof -i :${port} -P -n | grep LISTEN || true`;
  } else if (platform === 'win32') {
    command = `netstat -ano | findstr :${port} || exit 0`;
  } else {
    return { inUse: false };
  }

  const { stdout } = await exec(command);
  return parsePortInfo(stdout, platform, port);
}

/**
 * Check if port is in use and exit with helpful message if it is
 */
export async function checkIfPortInUse(port: number): Promise<void> {
  const portCheck = await getPortInfo(port);
  const GREEN = "\x1b[1;32m";
  const YELLOW = "\x1b[1;33m";
  const GREY = "\x1b[38;5;244m";
  const RESET = "\x1b[0m";

  if (portCheck.inUse) {
    let message = '';
    {
      if (portCheck.command === 'node') {
        message = `✅ A server instance is already running!`;
      }
      else if (portCheck.command) {
        message = `⚠️ Port ${port} is already in use by "${portCheck.command}"`;
      }
      else {
        // Windows: netstat gives no process name, only a PID
        message = `⚠️ Port ${port} is already in use`;
      }
      console.log(`${GREEN}┌${'─'.repeat(message.length + 3)}┐${RESET}`);
      console.log(`${GREEN}│${RESET} ${YELLOW}${message}${RESET} ${GREEN}│${RESET}`);
      console.log(`${GREEN}├${'─'.repeat(message.length + 3)}┤${RESET}`);
      if (portCheck.pid) {
        let kill_cmd = '';
        if (process.platform === 'darwin' || process.platform === 'linux') {
          kill_cmd = `      kill -9 ${portCheck.pid}`
        } else if (process.platform === 'win32') {
          kill_cmd = `      taskkill /PID ${portCheck.pid} /F`;
        }
        console.log(`${GREEN}│${RESET} ${GREY}${'   To stop the other instance, run:'.padEnd(message.length + 2)}${GREEN}│${RESET}`);
        console.log(`${GREEN}│${RESET} ${GREY}${kill_cmd.padEnd(message.length + 2)}${GREEN}│${RESET}`);
        console.log(`${GREEN}└${'─'.repeat(message.length + 3)}┘${RESET}`);
      }
    }

    console.log();
    process.exit(1);
  }
}
