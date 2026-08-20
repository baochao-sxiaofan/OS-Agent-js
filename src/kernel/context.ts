import type { JsonValue } from '../types/json.js';

export type SystemContextItem = {
  type: 'system';
  content: string;
};

export type UserContextItem = {
  type: 'user';
  content: string;
};

export type AssistantContextItem = {
  type: 'assistant';
  content: string;
};

export type ToolCallContextItem = {
  type: 'tool_call';
  callId: string;
  toolName: string;
  input: JsonValue;
};

export type ToolResultContextItem = {
  type: 'tool_result';
  callId: string;
  toolName: string;
  output: JsonValue;
};

export type ContextItem =
  | AssistantContextItem
  | SystemContextItem
  | ToolCallContextItem
  | ToolResultContextItem
  | UserContextItem;
