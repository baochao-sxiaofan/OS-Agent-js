import {
  ModelRequesterError,
  type ModelRequester,
  type ModelRequesterOptions,
} from '../api.js';
import { MiniMaxRequester } from './minimax-requester.js';

export function createModelRequester(options: ModelRequesterOptions): ModelRequester {
  switch (options.provider) {
    case 'minimax':
      return new MiniMaxRequester(options);
    case 'anthropic':
    case 'openai':
    case 'gemini':
      return {
        provider: options.provider,
        model: options.model,
        async request() {
          throw new ModelRequesterError(`${options.provider} model requester is not implemented.`, {
            provider: options.provider, code: 'not_implemented',
          });
        },
      };
    default:
      throw new Error('Unsupported model provider.');
  }
}
