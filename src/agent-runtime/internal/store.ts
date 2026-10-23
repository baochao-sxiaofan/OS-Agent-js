import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ContextCursor } from '../../agent-context/index.js';
import type { AgentSchedulerCheckpoint, AgentSchedulerPersistence, AsyncOperation } from '../../agent-scheduler/index.js';
import type { ModelCompletion, ModelCompletionRequest } from '../../model-requester/index.js';
import type { JsonObject, JsonValue } from '../../types/json.js';
import type { RuntimeAgent, RuntimeEvent, RuntimeInterrupt, RuntimeMessage } from '../api.js';
import { completionSchema, executionSchema, inputSchema, jsonSchema, requestSchema, parseRuntimeAgent, scheduleSchema } from './schema.js';

export type ExecutionOperation = {
  id: string;
  agentId: number;
  batchId: string;
  target: ContextCursor;
  toolName: string;
  arguments: JsonObject;
  state: 'registered' | 'running' | 'succeeded' | 'failed' | 'approval' | 'unknown';
  effect: 'read_only' | 'side_effect' | 'privileged';
  schedulerOperation: AsyncOperation | null;
  result: JsonValue | null;
};

type RuntimeInput = {
  agentId: number; content: string; target?: ContextCursor; createdAt?: number; sender?: string;
};

/** Context 与运行数据共用数据库文件；各写点幂等，恢复时跨表对账。 */
export class RuntimeStore implements AgentSchedulerPersistence {
  readonly #db: DatabaseSync;
  readonly #lock: DatabaseSync | null;
  constructor(location: string) {
    this.#lock = location === ':memory:' ? null : new DatabaseSync(`${location}.lock.sqlite`);
    try {
      // 独立 SQLite 事务充当进程锁；进程崩溃自动释放，不阻塞 Context 的主库连接。
      this.#lock?.exec('CREATE TABLE IF NOT EXISTS runtime_lock (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');
    } catch {
      this.#lock?.close();
      throw new Error('持久数据库已被另一个 Runtime 占用。');
    }
    this.#db = new DatabaseSync(location);
    this.#db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS runtime_agents (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_schedules (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_inputs (id TEXT PRIMARY KEY, agent_id INTEGER NOT NULL, body TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runtime_operations (id TEXT PRIMARY KEY, agent_id INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_completions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_requests (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_request_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, request TEXT, completion TEXT);
      CREATE TABLE IF NOT EXISTS runtime_interrupts (id TEXT PRIMARY KEY, agent_id INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, created_at INTEGER NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_artifacts (id TEXT PRIMARY KEY, agent_id INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_metadata (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    `);
  }

  reserveAgent(): number {
    return Number(this.#db.prepare("INSERT INTO runtime_agents (body) VALUES ('null')").run().lastInsertRowid);
  }
  saveAgent(agent: RuntimeAgent): void {
    this.#db.prepare('UPDATE runtime_agents SET body=? WHERE id=?').run(JSON.stringify(agent), agent.control.agentId);
  }
  agent(id: number): RuntimeAgent | undefined {
    const row = this.#db.prepare('SELECT body FROM runtime_agents WHERE id=?').get(id);
    return row && row.body !== 'null' ? parseRuntimeAgent(JSON.parse(String(row.body))) as unknown as RuntimeAgent : undefined;
  }
  agents(): RuntimeAgent[] {
    return this.#db.prepare("SELECT body FROM runtime_agents WHERE body!='null' ORDER BY id").all()
      .map((row) => parseRuntimeAgent(JSON.parse(String(row.body))) as unknown as RuntimeAgent);
  }
  load(id: number): AgentSchedulerCheckpoint | undefined {
    const row = this.#db.prepare('SELECT body FROM runtime_schedules WHERE id=?').get(id);
    return row ? scheduleSchema.parse(JSON.parse(String(row.body))) as AgentSchedulerCheckpoint : undefined;
  }
  save(checkpoint: AgentSchedulerCheckpoint): void {
    this.#db.prepare('INSERT INTO runtime_schedules VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(checkpoint.agentId, JSON.stringify(checkpoint));
  }
  input(id: string): RuntimeInput | undefined {
    const row = this.#db.prepare('SELECT body FROM runtime_inputs WHERE id=?').get(id);
    return row ? inputSchema.parse(JSON.parse(String(row.body))) as RuntimeInput : undefined;
  }
  putInput(id: string, input: Omit<RuntimeInput, 'createdAt'>): boolean {
    const existing = this.input(id);
    if (existing) {
      if (existing.agentId !== input.agentId || existing.content !== input.content ||
          existing.sender !== input.sender || JSON.stringify(existing.target) !== JSON.stringify(input.target)) {
        throw new Error('幂等键已用于不同消息。');
      }
      return false;
    }
    this.#db.prepare('INSERT INTO runtime_inputs (id,agent_id,body) VALUES (?,?,?)')
      .run(id, input.agentId, JSON.stringify({ ...input, createdAt: Date.now() }));
    return true;
  }
  messages(agentId: number, fallbackTime: number): RuntimeMessage[] {
    const inputs = this.#db.prepare('SELECT id,body FROM runtime_inputs WHERE agent_id=? ORDER BY rowid').all(agentId);
    const messages: RuntimeMessage[] = inputs.map((row) => {
      const input = inputSchema.parse(JSON.parse(String(row.body)));
      return { id: `input:${String(row.id)}`, agentId, createdAt: input.createdAt ?? fallbackTime,
        role: input.sender ? 'agent' : 'user', sender: input.sender ?? null, content: input.content };
    });
    const seen = new Set<string>();
    for (const event of this.events(agentId)) {
      const data = event.data;
      if (event.type !== 'output' || !data || typeof data !== 'object' || Array.isArray(data) ||
          typeof data.content !== 'string' || data.level !== undefined && data.level !== 1) continue;
      const id = typeof data.id === 'string' ? data.id : `event:${event.sequence}`;
      if (seen.has(id)) continue;
      seen.add(id);
      messages.push({ id, agentId, createdAt: event.createdAt, role: 'assistant', sender: null, content: data.content });
    }
    return messages.sort((a, b) => a.createdAt - b.createdAt);
  }
  inputs(agentId: number): { id: string; content: string; target?: ContextCursor }[] {
    return this.#db.prepare('SELECT id,body FROM runtime_inputs WHERE agent_id=? AND delivered=0').all(agentId)
      .map((row) => ({ ...inputSchema.parse(JSON.parse(String(row.body))) as { content: string; target?: ContextCursor }, id: String(row.id) }));
  }
  acknowledgeInput(id: string): void {
    this.#db.prepare('UPDATE runtime_inputs SET delivered=1 WHERE id=?').run(id);
  }
  operation(id: string): ExecutionOperation | undefined {
    const row = this.#db.prepare('SELECT body FROM runtime_operations WHERE id=?').get(id);
    return row ? executionSchema.parse(JSON.parse(String(row.body))) as ExecutionOperation : undefined;
  }
  operations(agentId: number): ExecutionOperation[] {
    return this.#db.prepare('SELECT body FROM runtime_operations WHERE agent_id=?').all(agentId)
      .map((row) => executionSchema.parse(JSON.parse(String(row.body))) as ExecutionOperation);
  }
  allOperations(): ExecutionOperation[] {
    return this.#db.prepare('SELECT body FROM runtime_operations').all()
      .map((row) => executionSchema.parse(JSON.parse(String(row.body))) as ExecutionOperation);
  }
  putOperation(operation: ExecutionOperation): void {
    this.#db.prepare('INSERT INTO runtime_operations VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(operation.id, operation.agentId, JSON.stringify(operation));
  }
  /** 对账终态与待投递标记同事务提交，崩溃后可幂等补投到 Context。 */
  putReconciliation(operation: ExecutionOperation): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.putOperation(operation);
      this.putMetadata(`reconciliation:${operation.id}`, true);
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  reconciliationPending(id: string): boolean { return this.metadata<boolean>(`reconciliation:${id}`) === true; }
  acknowledgeReconciliation(id: string): void { this.putMetadata(`reconciliation:${id}`, false); }
  hasUnknownMutation(workspace: string, locate: (agentId: number) => string): boolean {
    return this.allOperations().some((operation) => {
      return operation.state === 'unknown' && operation.effect !== 'read_only' && locate(operation.agentId) === workspace;
    });
  }
  completion(id: string): ModelCompletion | undefined {
    const row = this.#db.prepare('SELECT body FROM runtime_completions WHERE id=?').get(id);
    return row ? completionSchema.parse(JSON.parse(String(row.body))) as ModelCompletion : undefined;
  }
  putCompletion(id: string, completion: ModelCompletion): void {
    completionSchema.parse(completion);
    this.#db.prepare('INSERT OR IGNORE INTO runtime_completions VALUES (?,?)').run(id, JSON.stringify(completion));
  }
  repairRequest(id: string): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare(`INSERT INTO runtime_request_history (id,request,completion)
        SELECT ?, (SELECT body FROM runtime_requests WHERE id=?),
        (SELECT body FROM runtime_completions WHERE id=?)`).run(id, id, id);
      this.#db.prepare('DELETE FROM runtime_completions WHERE id=?').run(id);
      this.#db.prepare('DELETE FROM runtime_requests WHERE id=?').run(id);
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  request(id: string): ModelCompletionRequest | undefined {
    const row = this.#db.prepare('SELECT body FROM runtime_requests WHERE id=?').get(id);
    return row ? requestSchema.parse(JSON.parse(String(row.body))) as ModelCompletionRequest : undefined;
  }
  putRequest(id: string, request: ModelCompletionRequest): void {
    this.#db.prepare('INSERT OR IGNORE INTO runtime_requests VALUES (?,?)').run(id, JSON.stringify(request));
  }
  putInterrupt(interrupt: RuntimeInterrupt): void {
    this.#db.prepare('INSERT OR IGNORE INTO runtime_interrupts VALUES (?,?,?)')
      .run(interrupt.id, interrupt.agentId, JSON.stringify(interrupt));
  }
  interrupts(agentId: number): RuntimeInterrupt[] {
    return this.#db.prepare('SELECT body FROM runtime_interrupts WHERE agent_id=? ORDER BY rowid').all(agentId)
      .map((row) => JSON.parse(String(row.body)) as RuntimeInterrupt);
  }
  event(agentId: number, type: string, data: JsonValue): RuntimeEvent {
    jsonSchema.parse(data);
    const createdAt = Date.now();
    const result = this.#db.prepare('INSERT INTO runtime_events (agent_id,created_at,type,body) VALUES (?,?,?,?)')
      .run(agentId, createdAt, type, JSON.stringify(data));
    return { sequence: Number(result.lastInsertRowid), agentId, createdAt, type, data };
  }
  events(agentId: number, after = 0): RuntimeEvent[] {
    return this.#db.prepare('SELECT * FROM runtime_events WHERE agent_id=? AND sequence>? ORDER BY sequence').all(agentId, after)
      .map((row) => ({ sequence: Number(row.sequence), agentId: Number(row.agent_id), createdAt: Number(row.created_at),
        type: String(row.type), data: jsonSchema.parse(JSON.parse(String(row.body))) }));
  }
  artifact(agentId: number, value: JsonValue, id = `artifact://${randomUUID()}`): string {
    this.#db.prepare('INSERT OR IGNORE INTO runtime_artifacts VALUES (?,?,?)').run(id, agentId, JSON.stringify(value));
    return id;
  }
  readArtifact(agentId: number, id: string): JsonValue | undefined {
    const row = this.#db.prepare('SELECT body FROM runtime_artifacts WHERE id=? AND agent_id=?').get(id, agentId);
    return row ? jsonSchema.parse(JSON.parse(String(row.body))) : undefined;
  }
  metadata<T>(id: string): T | undefined {
    const row = this.#db.prepare('SELECT body FROM runtime_metadata WHERE id=?').get(id);
    return row ? JSON.parse(String(row.body)) as T : undefined;
  }
  putMetadata(id: string, value: JsonValue): void {
    this.#db.prepare('INSERT INTO runtime_metadata VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(id, JSON.stringify(value));
  }
  close(): void { this.#db.close(); this.#lock?.close(); }
}
