import { describe, it, expect } from 'vitest';
import { classifyConnectionError } from './connection-test.js';

describe('classifyConnectionError', () => {
  it('classifies HTTP 401 as auth', () => {
    const err = { message: 'Unauthorized', response: { status: 401 } };
    expect(classifyConnectionError(err)).toEqual({
      success: false,
      error: 'Unauthorized',
      errorType: 'auth',
    });
  });

  it('classifies HTTP 403 as permission', () => {
    const err = { message: 'Forbidden', response: { status: 403 } };
    expect(classifyConnectionError(err)).toEqual({
      success: false,
      error: 'Forbidden',
      errorType: 'permission',
    });
  });

  it('classifies HTTP 404 as not_found', () => {
    const err = { message: 'Not Found', response: { status: 404 } };
    expect(classifyConnectionError(err)).toEqual({
      success: false,
      error: 'Not Found',
      errorType: 'not_found',
    });
  });

  it('classifies ECONNREFUSED as network', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(classifyConnectionError(err)).toEqual({
      success: false,
      error: 'connect ECONNREFUSED',
      errorType: 'network',
    });
  });

  it('classifies ENOTFOUND as network', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    expect(classifyConnectionError(err).errorType).toBe('network');
  });

  it('classifies ETIMEDOUT as network', () => {
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(classifyConnectionError(err).errorType).toBe('network');
  });

  it('classifies ECONNABORTED as network', () => {
    const err = Object.assign(new Error('aborted'), { code: 'ECONNABORTED' });
    expect(classifyConnectionError(err).errorType).toBe('network');
  });

  it('classifies a 500 with response as unknown', () => {
    const err = { message: 'Internal Server Error', response: { status: 500 } };
    expect(classifyConnectionError(err).errorType).toBe('unknown');
  });

  it('classifies a plain Error with no code/response as network', () => {
    // Bare Error (e.g. fetch() failing pre-response) — duck-typing falls
    // through to the "no response, no code" branch.
    const err = new Error('boom');
    expect(classifyConnectionError(err).errorType).toBe('network');
  });

  it('classifies a string as unknown', () => {
    expect(classifyConnectionError('plain string')).toEqual({
      success: false,
      error: 'plain string',
      errorType: 'unknown',
    });
  });

  it('classifies null as unknown', () => {
    expect(classifyConnectionError(null).errorType).toBe('unknown');
  });

  it('preserves the original message in error field', () => {
    const err = new Error('specific message');
    expect(classifyConnectionError(err).error).toBe('specific message');
  });
});
