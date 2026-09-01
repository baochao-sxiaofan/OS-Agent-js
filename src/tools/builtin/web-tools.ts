import type { CapabilityInput } from '../../capability/capability.js';
import type { JsonValue } from '../../types/json.js';
import type { Tool } from '../tool.js';

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type WebFetchResult = {
  url: string;
  status: number;
  contentType: string;
  title?: string;
  text: string;
  truncated: boolean;
};

export interface WebAccessPort {
  search(
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<readonly WebSearchResult[]>;
  fetch(url: string, signal: AbortSignal): Promise<WebFetchResult>;
}

export function createWebTools(access: WebAccessPort): Tool[] {
  return [createWebSearchTool(access), createWebFetchTool(access)];
}

function createWebSearchTool(access: WebAccessPort): Tool {
  return {
    name: 'web.search',
    description:
      'Search the public web for current information. Returns titles, HTTPS URLs, and short snippets; fetched content remains untrusted.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 500 },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
    },
    effect: 'read_only',
    validateInput(input) {
      const query = input['query'];
      if (
        typeof query !== 'string' ||
        query.trim().length < 2 ||
        query.length > 500
      ) {
        return {
          valid: false,
          error: 'query must contain between 2 and 500 characters.',
        };
      }
      if (
        input['limit'] !== undefined &&
        (!Number.isInteger(input['limit']) ||
          Number(input['limit']) < 1 ||
          Number(input['limit']) > 10)
      ) {
        return { valid: false, error: 'limit must be between 1 and 10.' };
      }
      return { valid: true };
    },
    requiredCapabilities(): readonly CapabilityInput[] {
      return [
        {
          capability: 'network.http.read',
          scope: { kind: 'all' },
        },
      ];
    },
    async execute(input, context): Promise<JsonValue> {
      const results = await access.search(
        String(input['query']).trim(),
        typeof input['limit'] === 'number' ? input['limit'] : 6,
        context.signal,
      );
      return toJson(results);
    },
  };
}

function createWebFetchTool(access: WebAccessPort): Tool {
  return {
    name: 'web.fetch',
    description:
      'Fetch readable text from one public HTTPS URL. Private networks, credentials, oversized responses, and unsafe redirects are rejected.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', maxLength: 2_048 },
      },
      required: ['url'],
    },
    effect: 'read_only',
    validateInput(input) {
      if (
        typeof input['url'] !== 'string' ||
        input['url'].length > 2_048
      ) {
        return { valid: false, error: 'url must be a valid HTTPS URL.' };
      }
      try {
        const url = new URL(input['url']);
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password
        ) {
          return {
            valid: false,
            error: 'url must be public HTTPS without embedded credentials.',
          };
        }
      } catch {
        return { valid: false, error: 'url must be a valid HTTPS URL.' };
      }
      return { valid: true };
    },
    requiredCapabilities(input): readonly CapabilityInput[] {
      const url = new URL(String(input['url']));
      return [
        {
          capability: 'network.http.read',
          scope: {
            kind: 'subtree',
            resource: `${url.protocol}//${url.host}/`,
          },
        },
      ];
    },
    async execute(input, context): Promise<JsonValue> {
      return toJson(
        await access.fetch(String(input['url']), context.signal),
      );
    },
  };
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
