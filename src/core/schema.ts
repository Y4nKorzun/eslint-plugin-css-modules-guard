import type { JSONSchema4 } from '@typescript-eslint/utils/json-schema';

/**
 * Every CSS Modules rule accepts the same options, and they share one extraction cache, so the
 * schema lives here instead of being copied per rule. ESLint only reads the schema, so one frozen
 * object is safe to hand to all of them.
 */
export const cssModulesOptionsSchema: readonly [JSONSchema4] = [
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      localsConvention: {
        type: 'string',
        enum: ['asIs', 'camelCase', 'camelCaseOnly', 'dashes'],
      },
      aliases: {
        type: 'object',
        additionalProperties: { type: 'string' },
      },
      sassLoadPaths: {
        type: 'array',
        items: { type: 'string' },
      },
      suggestThreshold: {
        type: 'integer',
        minimum: 0,
        maximum: 10,
      },
      cache: { type: 'boolean' },
      cacheLimit: {
        type: 'integer',
        minimum: 1,
      },
    },
  },
];
