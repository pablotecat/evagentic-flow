import type { ApiFailure } from './types';

export type { ApiFailure };

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const init: RequestInit = { ...options };
  if (options.body !== undefined) {
    init.headers = { 'content-type': 'application/json', ...(options.headers ?? {}) };
  }
  const response = await fetch(path, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw { status: response.status, body } as ApiFailure;
  return body as T;
}

export const isApiFailure = (error: unknown): error is ApiFailure =>
  typeof error === 'object' && error !== null
  && typeof (error as ApiFailure).status === 'number';
