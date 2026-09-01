import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type {
  WebAccessPort,
  WebFetchResult,
  WebSearchResult,
} from '../../../src/index.js';

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Network adapter for research tools.
 *
 * Every destination is revalidated before each redirect. This blocks obvious
 * localhost/private-address SSRF paths while keeping network policy outside
 * the Agent and Tool schema.
 */
export class SafeWebAccess implements WebAccessPort {
  async search(
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<readonly WebSearchResult[]> {
    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('no_redirect', '1');
    url.searchParams.set('skip_disambig', '1');
    const response = await fetchWithTimeout(url, signal);
    if (!response.ok) {
      throw new Error(`Web search failed with HTTP ${response.status}.`);
    }
    const body = JSON.parse(
      new TextDecoder().decode(await readBoundedResponse(response)),
    ) as unknown;
    if (!isObject(body)) {
      throw new Error('Web search returned an invalid response.');
    }
    const results: WebSearchResult[] = [];
    const abstractUrl = stringValue(body['AbstractURL']);
    const abstractText = stringValue(body['AbstractText']);
    if (abstractUrl && abstractText) {
      results.push({
        title: stringValue(body['Heading']) || query,
        url: requireHttpsUrl(abstractUrl),
        snippet: abstractText,
      });
    }
    collectRelatedTopics(body['RelatedTopics'], results, limit);
    return deduplicate(results).slice(0, limit);
  }

  async fetch(url: string, signal: AbortSignal): Promise<WebFetchResult> {
    let current = new URL(url);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      await assertPublicHttpsUrl(current);
      const response = await fetchWithTimeout(current, signal, {
        redirect: 'manual',
        headers: {
          accept: 'text/html, text/plain, application/json;q=0.9',
          'user-agent': 'OS-Agent-js/enterprise-preview',
        },
      });
      if (isRedirect(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error('Web response redirected without a location.');
        }
        current = new URL(location, current);
        continue;
      }
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > MAX_RESPONSE_BYTES) {
        throw new Error('Web response exceeds the 1 MB safety limit.');
      }
      const bytes = await readBoundedResponse(response);
      const text = new TextDecoder().decode(bytes);
      const contentType =
        response.headers.get('content-type') ?? 'text/plain';
      const title = contentType.includes('html')
        ? extractTitle(text)
        : undefined;
      return {
        url: current.toString(),
        status: response.status,
        contentType,
        ...(title === undefined ? {} : { title }),
        text: contentType.includes('html')
          ? htmlToText(text)
          : text,
        truncated: false,
      };
    }
    throw new Error(`Web request exceeded ${MAX_REDIRECTS} redirects.`);
  }
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel('Response exceeded the safety limit.');
        throw new Error('Web response exceeds the 1 MB safety limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function assertPublicHttpsUrl(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    hostname.toLowerCase() === 'localhost'
  ) {
    throw new Error('Only public HTTPS URLs are allowed.');
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new Error('Private or unresolved network destinations are denied.');
  }
}

function isPrivateAddress(address: string): boolean {
  const normalized = address
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .split('%')[0] ?? '';
  if (normalized === '::1' || normalized === '::') {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (mapped.includes('.')) {
      return isPrivateAddress(mapped);
    }
    const groups = mapped.split(':');
    if (groups.length === 2) {
      const high = Number.parseInt(groups[0] ?? '', 16);
      const low = Number.parseInt(groups[1] ?? '', 16);
      if (Number.isInteger(high) && Number.isInteger(low)) {
        return isPrivateAddress(
          `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
        );
      }
    }
    return true;
  }
  if (
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff')
  ) {
    return true;
  }
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [first = 0, second = 0] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

async function fetchWithTimeout(
  url: URL,
  parentSignal: AbortSignal,
  init: RequestInit = {},
): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = AbortSignal.any([parentSignal, timeout]);
  return await fetch(url, { ...init, signal });
}

function collectRelatedTopics(
  value: unknown,
  results: WebSearchResult[],
  limit: number,
): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const entry of value) {
    if (results.length >= limit) {
      return;
    }
    if (!isObject(entry)) {
      continue;
    }
    if (Array.isArray(entry['Topics'])) {
      collectRelatedTopics(entry['Topics'], results, limit);
      continue;
    }
    const url = stringValue(entry['FirstURL']);
    const snippet = stringValue(entry['Text']);
    if (!url || !snippet) {
      continue;
    }
    try {
      results.push({
        title: snippet.split(' - ')[0] || snippet,
        url: requireHttpsUrl(url),
        snippet,
      });
    } catch {
      // Ignore non-HTTPS results from the upstream search service.
    }
  }
}

function deduplicate(results: readonly WebSearchResult[]): WebSearchResult[] {
  return [
    ...new Map(results.map((result) => [result.url, result])).values(),
  ];
}

function requireHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error('Search result URL is not HTTPS.');
  }
  return url.toString();
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/giu, ' ')
      .replace(/<style[\s\S]*?<\/style>/giu, ' ')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  ).slice(0, MAX_RESPONSE_BYTES);
}

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  return match ? decodeEntities(match[1]?.trim() ?? '') : undefined;
}

function decodeEntities(text: string): string {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
