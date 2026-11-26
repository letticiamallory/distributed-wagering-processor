import { expect } from 'bun:test';
import type { HttpResult, Json } from './http-app.js';

const JSON_TYPE = /^application\/json\b/;

// O formato ÚNICO de erro, igual em todas as rotas e em todos os status de erro:
//   { "error": { "code", "message", "retryable", "correlationId", ["details"] } }
// `details` só existe quando é o payload que está errado (400). Nada mais vaza.
export function expectError(
  response: HttpResult,
  expected: {
    status: number;
    code: string;
    retryable?: boolean;
    withDetails?: boolean;
  },
): Json {
  expect(response.status).toBe(expected.status);
  expect(response.headers.get('content-type') ?? '').toMatch(JSON_TYPE);
  expect(Object.keys(response.body ?? {})).toEqual(['error']);
  const error = (response.body as { error: Json }).error;

  const allowed = ['code', 'message', 'retryable', 'correlationId'];
  if (expected.withDetails) allowed.push('details');
  for (const key of Object.keys(error)) {
    expect(allowed).toContain(key);
  }
  expect(error.code).toBe(expected.code);
  expect(typeof error.message).toBe('string');
  expect((error.message as string).length).toBeGreaterThan(0);
  expect(error.retryable).toBe(expected.retryable ?? false);
  // O mesmo id que o provedor recebe no cabeçalho: com ele se acha a linha de log.
  expect(typeof error.correlationId).toBe('string');
  expect(error.correlationId).toBe(response.headers.get('x-correlation-id'));
  if (expected.withDetails) {
    expect(Array.isArray(error.details)).toBe(true);
    for (const detail of error.details as Json[]) {
      expect(Object.keys(detail).sort((a, b) => a.localeCompare(b))).toEqual([
        'message',
        'path',
      ]);
    }
  }
  return error;
}

export function detailPaths(error: Json): string[] {
  return ((error.details ?? []) as Array<{ path: string }>).map((d) => d.path);
}
