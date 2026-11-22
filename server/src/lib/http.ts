import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    message: string,
    public code = 'error',
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new ApiError(400, message, 'bad_request');
export const unauthorized = (message = 'Please sign in to continue.') => new ApiError(401, message, 'unauthorized');
export const forbidden = (message = 'You do not have permission to do that.') => new ApiError(403, message, 'forbidden');
export const notFound = (message = 'Not found.') => new ApiError(404, message, 'not_found');
export const conflict = (message: string) => new ApiError(409, message, 'conflict');

export async function readJson(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('The request body must be valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('The request body must be a JSON object.');
  return body as Record<string, unknown>;
}

export function str(value: unknown, name: string, opts: { min?: number; max?: number; optional?: boolean } = {}): string {
  if (value === undefined || value === null) {
    if (opts.optional) return '';
    throw badRequest(`${name} is required.`);
  }
  if (typeof value !== 'string') throw badRequest(`${name} must be text.`);
  const v = value.trim();
  if (opts.min !== undefined && v.length < opts.min) throw badRequest(`${name} must be at least ${opts.min} characters.`);
  if (opts.max !== undefined && v.length > opts.max) throw badRequest(`${name} must be at most ${opts.max} characters.`);
  return v;
}

export function int(value: unknown, name: string, opts: { min?: number; max?: number } = {}): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) throw badRequest(`${name} must be a whole number.`);
  if (opts.min !== undefined && n < opts.min) throw badRequest(`${name} must be at least ${opts.min}.`);
  if (opts.max !== undefined && n > opts.max) throw badRequest(`${name} must be at most ${opts.max}.`);
  return n;
}

export function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw badRequest(`${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

export function optionalInt(value: string | undefined, name: string, fallback: number, opts: { min?: number; max?: number } = {}) {
  if (value === undefined || value === '') return fallback;
  return int(value, name, opts);
}

export const HASH_RE = /^[0-9a-f]{64}$/;

export function hashParam(value: unknown, name = 'hash'): string {
  if (typeof value !== 'string' || !HASH_RE.test(value)) throw badRequest(`${name} must be a SHA-256 hex digest.`);
  return value;
}

/** Splits an array into chunks so D1 queries stay under the 100 bound-parameter limit. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
