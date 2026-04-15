export abstract class AppError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly jsonRpcCode: number;
  abstract readonly retryable: boolean;
  readonly publicMessage: string;

  constructor(message: string, publicMessage?: string) {
    super(message);
    this.name = this.constructor.name;
    this.publicMessage = publicMessage ?? 'An error occurred.';
  }
}

export class ValidationError extends AppError {
  readonly httpStatus = 400;
  readonly jsonRpcCode = -32602;
  readonly retryable = false;
}

export abstract class AuthError extends AppError {
  readonly httpStatus = 401;
  readonly retryable = false;
}

export class AuthRequiredError extends AuthError {
  readonly jsonRpcCode = -32001;
}

export class AuthMalformedTokenError extends AuthError {
  readonly jsonRpcCode = -32002;
}

export class AuthInvalidCredentialsError extends AuthError {
  readonly jsonRpcCode = -32003;
}

export class KeyBlacklistedError extends AppError {
  readonly httpStatus = 403;
  readonly jsonRpcCode = -32004;
  readonly retryable = false;
}

export class KeyDeletedError extends AppError {
  readonly httpStatus = 403;
  readonly jsonRpcCode = -32005;
  readonly retryable = false;
}

export class RateLimitError extends AppError {
  readonly httpStatus = 429;
  readonly jsonRpcCode = -32029;
  readonly retryable = true;
}

export class NotFoundError extends AppError {
  readonly httpStatus = 404;
  readonly jsonRpcCode = -32011;
  readonly retryable = false;
}

export class ConflictError extends AppError {
  readonly httpStatus = 409;
  readonly jsonRpcCode = -32012;
  readonly retryable = false;
}

export class TransientError extends AppError {
  readonly httpStatus = 503;
  readonly jsonRpcCode = -32013;
  readonly retryable = true;
}

// ConfigError is only thrown at startup; the HTTP/JSON-RPC fields are never consumed.
export class ConfigError extends AppError {
  readonly httpStatus = 500;
  readonly jsonRpcCode = -32603;
  readonly retryable = false;
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
