import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AppError,
  AuthError,
  AuthInvalidCredentialsError,
  AuthMalformedTokenError,
  AuthRequiredError,
  ConfigError,
  ConflictError,
  isAppError,
  KeyBlacklistedError,
  KeyDeletedError,
  NotFoundError,
  OriginOrHostRejectedError,
  RateLimitError,
  SessionNotFoundError,
  TransientError,
  ValidationError,
} from './errors.ts';

type Expected = {
  readonly httpStatus: number;
  readonly jsonRpcCode: number;
  readonly retryable: boolean;
  readonly name: string;
};

type Ctor = new (message: string, publicMessage?: string) => AppError;

const cases: Array<readonly [string, Ctor, Expected]> = [
  [
    'ValidationError',
    ValidationError,
    { httpStatus: 400, jsonRpcCode: -32602, retryable: false, name: 'ValidationError' },
  ],
  [
    'AuthRequiredError',
    AuthRequiredError,
    { httpStatus: 401, jsonRpcCode: -32001, retryable: false, name: 'AuthRequiredError' },
  ],
  [
    'AuthMalformedTokenError',
    AuthMalformedTokenError,
    { httpStatus: 401, jsonRpcCode: -32002, retryable: false, name: 'AuthMalformedTokenError' },
  ],
  [
    'AuthInvalidCredentialsError',
    AuthInvalidCredentialsError,
    {
      httpStatus: 401,
      jsonRpcCode: -32003,
      retryable: false,
      name: 'AuthInvalidCredentialsError',
    },
  ],
  [
    'KeyBlacklistedError',
    KeyBlacklistedError,
    { httpStatus: 403, jsonRpcCode: -32004, retryable: false, name: 'KeyBlacklistedError' },
  ],
  [
    'KeyDeletedError',
    KeyDeletedError,
    { httpStatus: 403, jsonRpcCode: -32005, retryable: false, name: 'KeyDeletedError' },
  ],
  [
    'RateLimitError',
    RateLimitError,
    { httpStatus: 429, jsonRpcCode: -32029, retryable: true, name: 'RateLimitError' },
  ],
  [
    'NotFoundError',
    NotFoundError,
    { httpStatus: 404, jsonRpcCode: -32011, retryable: false, name: 'NotFoundError' },
  ],
  [
    'ConflictError',
    ConflictError,
    { httpStatus: 409, jsonRpcCode: -32012, retryable: false, name: 'ConflictError' },
  ],
  [
    'TransientError',
    TransientError,
    { httpStatus: 503, jsonRpcCode: -32013, retryable: true, name: 'TransientError' },
  ],
  [
    'ConfigError',
    ConfigError,
    { httpStatus: 500, jsonRpcCode: -32603, retryable: false, name: 'ConfigError' },
  ],
  [
    'SessionNotFoundError',
    SessionNotFoundError,
    { httpStatus: 404, jsonRpcCode: -32006, retryable: false, name: 'SessionNotFoundError' },
  ],
  [
    'OriginOrHostRejectedError',
    OriginOrHostRejectedError,
    {
      httpStatus: 403,
      jsonRpcCode: -32007,
      retryable: false,
      name: 'OriginOrHostRejectedError',
    },
  ],
];

describe('AppError hierarchy', () => {
  for (const [label, Ctor, expected] of cases) {
    describe(label, () => {
      it('has the documented httpStatus / jsonRpcCode / retryable constants', () => {
        const err = new Ctor('internal', 'public');
        assert.equal(err.httpStatus, expected.httpStatus);
        assert.equal(err.jsonRpcCode, expected.jsonRpcCode);
        assert.equal(err.retryable, expected.retryable);
      });

      it('sets name from the constructor', () => {
        const err = new Ctor('internal');
        assert.equal(err.name, expected.name);
      });

      it('preserves the internal message and exposes publicMessage', () => {
        const err = new Ctor('internal secret detail', 'public safe message');
        assert.equal(err.message, 'internal secret detail');
        assert.equal(err.publicMessage, 'public safe message');
      });

      it('defaults publicMessage when omitted', () => {
        const err = new Ctor('internal only');
        assert.equal(err.publicMessage, 'An error occurred.');
      });

      it('is detected by isAppError', () => {
        assert.equal(isAppError(new Ctor('x')), true);
      });

      it('is an instance of Error and AppError', () => {
        const err = new Ctor('x');
        assert.ok(err instanceof Error);
        assert.ok(err instanceof AppError);
      });
    });
  }
});

describe('AuthError subclasses', () => {
  it('all extend the abstract AuthError base', () => {
    assert.ok(new AuthRequiredError('x') instanceof AuthError);
    assert.ok(new AuthMalformedTokenError('x') instanceof AuthError);
    assert.ok(new AuthInvalidCredentialsError('x') instanceof AuthError);
  });

  it('share the 401 / not-retryable shape but differ in jsonRpcCode', () => {
    const codes = new Set([
      new AuthRequiredError('x').jsonRpcCode,
      new AuthMalformedTokenError('x').jsonRpcCode,
      new AuthInvalidCredentialsError('x').jsonRpcCode,
    ]);
    assert.equal(codes.size, 3);
  });
});

describe('isAppError', () => {
  it('returns true for any AppError subclass instance', () => {
    assert.equal(isAppError(new ValidationError('x')), true);
    assert.equal(isAppError(new RateLimitError('x')), true);
  });

  it('returns false for plain Error and non-error values', () => {
    assert.equal(isAppError(new Error('nope')), false);
    assert.equal(isAppError('string'), false);
    assert.equal(isAppError(null), false);
    assert.equal(isAppError(undefined), false);
    assert.equal(isAppError({ httpStatus: 400 }), false);
  });
});
