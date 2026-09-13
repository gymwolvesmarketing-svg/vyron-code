export function checkTcpReachable(host: string, port: number, timeoutMs?: number): Promise<boolean>;
export function parseEnvFile(content: string): Record<string, string>;
export function readEnvLocal(cwd: string): Record<string, string>;
