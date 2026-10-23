import type { AgentRuntime, CreateRuntimeAgent } from '../agent-runtime/index.js';

export type ServerProfile = Omit<CreateRuntimeAgent, 'ownerId' | 'objective'>;
export type ServerPrincipal = {
  readonly token: string;
  readonly ownerId: string;
  readonly profiles: readonly string[];
};
export type AgentServerOptions = {
  readonly runtime: AgentRuntime;
  readonly profiles: Readonly<Record<string, ServerProfile>>;
  readonly principals: readonly ServerPrincipal[];
  readonly host?: string;
  readonly port?: number;
};
export interface AgentServer {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}
