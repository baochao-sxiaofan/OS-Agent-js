import type { JsonObject, JsonValue } from '../types/json.js';
import { jsonSchema } from '../types/json-schema.js';

export type RequestChange = { path: string[]; value?: JsonValue; append?: JsonValue[]; remove?: true };
const object = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Reconstruct current input for deterministic requesters; historical records are not new deliveries. */
export function readRuntimeRequest(request: { messages: readonly { role: string; content: unknown }[] }): JsonObject {
  let view: JsonObject = {};
  for (const message of request.messages) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    let parsed: unknown;
    try { parsed = JSON.parse(message.content); } catch { continue; }
    const checked = jsonSchema.safeParse(parsed);
    if (!checked.success || !object(checked.data)) continue;
    const data = checked.data;
    if (data.kind === 'runtime_context' && object(data.view)) view = structuredClone(data.view);
    else if (data.kind === 'runtime_update' && Array.isArray(data.changes)) {
      for (const change of data.changes) {
        if (!object(change) || !Array.isArray(change.path) || !change.path.length ||
            change.path.some((key) => typeof key !== 'string')) {
          throw new Error('Invalid runtime update path.');
        }
        const path = change.path as string[];
        let parent: JsonObject | JsonValue[] = view;
        for (const key of path.slice(0, -1)) {
          if (!Object.hasOwn(parent, key)) throw new Error('Invalid runtime update target.');
          const next: JsonValue | undefined = Array.isArray(parent) ? parent[Number(key)] : parent[key];
          if (!object(next) && !Array.isArray(next)) throw new Error('Invalid runtime update target.');
          parent = next;
        }
        const key = path.at(-1)!;
        const target = parent as JsonObject;
        if (change.remove === true) delete target[key];
        else if (Array.isArray(change.append)) {
          if (!Object.hasOwn(target, key)) throw new Error('Invalid runtime append target.');
          const current = target[key];
          if (!Array.isArray(current)) throw new Error('Invalid runtime append target.');
          current.push(...structuredClone(change.append));
        } else if (change.value !== undefined) Object.defineProperty(target, key, {
          value: structuredClone(change.value), enumerable: true, configurable: true, writable: true,
        });
      }
    } else view = structuredClone(data);
  }
  return view;
}

export function requestChanges(before: JsonObject, after: JsonObject): RequestChange[] {
  const changes: RequestChange[] = [];
  const visit = (old: JsonValue | undefined, value: JsonValue | undefined, path: string[]): void => {
    if (JSON.stringify(old) === JSON.stringify(value)) return;
    if (value === undefined) { changes.push({ path, remove: true }); return; }
    if (object(old) && object(value)) {
      for (const key of new Set([...Object.keys(old), ...Object.keys(value)])) visit(old[key], value[key], [...path, key]);
    } else if (Array.isArray(old) && Array.isArray(value) && old.length <= value.length &&
        old.every((item, i) => JSON.stringify(item) === JSON.stringify(value[i]))) {
      changes.push({ path, append: value.slice(old.length) });
    } else if (Array.isArray(old) && Array.isArray(value) && old.length === value.length) {
      value.forEach((item, i) => visit(old[i], item, [...path, String(i)]));
    } else changes.push({ path, value });
  };
  visit(before, after, []);
  return changes;
}
