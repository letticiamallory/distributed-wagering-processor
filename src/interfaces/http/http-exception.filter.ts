import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOnlyErrorCode } from '../../application/errors/api-error-code.js';
import {
  ApplicationError,
  InvalidCommandError,
} from '../../application/errors/application-errors.js';
import { FailureCode } from '../../domain/errors/failure-code.js';
import {
  CORRELATION_ID_HEADER,
  currentCorrelationId,
} from './correlation-id.js';
import { HttpConfig } from './http-config.js';
import { statusOfError } from './http-status.js';
import { StoredFailureReplayError } from './stored-failure-replay.error.js';

// O ÚNICO formato de erro da API, igual em todas as rotas:
//   { "error": { "code", "message", "retryable", "correlationId", ["details"] } }
// O que o provedor lê é só isto. A causa de verdade (SQL, constraint, stack) vai para o LOG, com o
// mesmo correlationId, e nunca para a resposta.
interface ErrorView {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  details?: Array<{ path: string; message: string }>;
  // Campos a mais que só alguns erros têm (o replay de FAILED).
  extras?: Record<string, unknown>;
  // Que nível de log o erro merece: 4xx não é erro nosso; 503 é esperado sob carga; o resto é bug.
  level: 'none' | 'warn' | 'error' | 'fatal';
  // O erro original, para o log.
  cause: unknown;
}

const GENERIC_INTERNAL = 'Internal server error';
const GENERIC_UNAVAILABLE =
  'The service is temporarily unavailable; retry the same request';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  constructor(private readonly config: HttpConfig) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) {
      return;
    }
    const correlationId = currentCorrelationId();
    const view = describe(error);

    this.log(view, correlationId);

    // Mesmo se o erro nasceu antes do middleware, a resposta sempre leva o id.
    if (!response.getHeader(CORRELATION_ID_HEADER)) {
      response.setHeader(CORRELATION_ID_HEADER, correlationId);
    }
    if (view.status === 503) {
      response.setHeader('Retry-After', String(this.config.retryAfterSeconds));
    }
    response.status(view.status).json({
      error: {
        code: view.code,
        message: view.message,
        retryable: view.retryable,
        correlationId,
        ...(view.details && { details: view.details }),
        ...view.extras,
      },
    });
  }

  private log(view: ErrorView, correlationId: string): void {
    if (view.level === 'none') {
      return;
    }
    const cause = view.cause;
    const entry = {
      event: 'request_failed',
      correlationId,
      status: view.status,
      code: view.code,
      error: cause instanceof Error ? cause.name : typeof cause,
      message: cause instanceof Error ? cause.message : String(cause),
      ...(cause instanceof Error &&
        cause.cause !== undefined && { cause: textOf(cause.cause) }),
      ...(view.extras && { ...view.extras }),
    };
    const stack = cause instanceof Error ? cause.stack : undefined;
    // `fatal` é o nível mais alto do Logger do Nest: reservado ao que NUNCA deveria acontecer.
    if (view.level === 'fatal') {
      this.logger.fatal(entry, stack);
    } else if (view.level === 'error') {
      this.logger.error(entry, stack);
    } else {
      this.logger.warn(entry);
    }
  }
}

// Texto de uma causa qualquer para o log (Error, string ou objeto), sem "[object Object]".
function textOf(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function describe(error: unknown): ErrorView {
  if (error instanceof StoredFailureReplayError) {
    return {
      status: statusOfError(ApiOnlyErrorCode.InternalError),
      code: error.code,
      message:
        'The transaction ended in failure; sending the same key again gives the same answer',
      retryable: false,
      extras: {
        failureCode: error.result.failureCode,
        transactionId: error.result.transactionId,
      },
      level: 'error',
      cause: error,
    };
  }

  if (error instanceof InvalidCommandError) {
    return {
      status: statusOfError(error.code),
      code: error.code,
      message: error.message,
      retryable: false,
      details: error.details,
      level: 'none',
      cause: error,
    };
  }

  if (error instanceof ApplicationError) {
    const status = statusOfError(error.code);
    if (status === 503) {
      return {
        status,
        code: error.code,
        message: GENERIC_UNAVAILABLE,
        retryable: true,
        level: 'warn',
        cause: error,
      };
    }
    if (status >= 500) {
      return {
        status,
        code: ApiOnlyErrorCode.InternalError,
        message: GENERIC_INTERNAL,
        retryable: false,
        // O que nunca deveria acontecer vai no nível mais alto, uma vez só.
        level: error.critical ? 'fatal' : 'error',
        cause: error,
      };
    }
    return {
      status,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      level: 'none',
      cause: error,
    };
  }

  // O que o framework e o parser do corpo levantam, no mesmo formato.
  const transport = describeTransportError(error);
  if (transport) {
    return transport;
  }

  return {
    status: 500,
    code: ApiOnlyErrorCode.InternalError,
    message: GENERIC_INTERNAL,
    retryable: false,
    level: 'error',
    cause: error,
  };
}

const ROUTE_NOT_FOUND = 'ROUTE_NOT_FOUND';
const PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE';

function describeTransportError(error: unknown): ErrorView | undefined {
  const status = transportStatusOf(error);
  if (status === undefined || status >= 500) {
    return undefined;
  }
  if (status === 404) {
    return view(status, ROUTE_NOT_FOUND, 'Route not found', error);
  }
  if (status === 413) {
    return view(
      status,
      PAYLOAD_TOO_LARGE,
      'The request body is too large',
      error,
    );
  }
  return view(
    400,
    FailureCode.InvalidPayload,
    'The request body could not be read (it must be valid JSON)',
    error,
  );
}

function view(
  status: number,
  code: string,
  message: string,
  cause: unknown,
): ErrorView {
  return { status, code, message, retryable: false, level: 'none', cause };
}

// HttpException do Nest (rota inexistente, JSON malformado que o Nest mapeia) e os erros do
// body-parser (que trazem `status` e `type`, como "entity.too.large").
function transportStatusOf(error: unknown): number | undefined {
  if (error instanceof HttpException) {
    return error.getStatus();
  }
  if (error instanceof SyntaxError) {
    return 400;
  }
  if (typeof error === 'object' && error !== null) {
    const { status, statusCode, type } = error as {
      status?: unknown;
      statusCode?: unknown;
      type?: unknown;
    };
    const candidate = typeof status === 'number' ? status : statusCode;
    if (typeof candidate === 'number' && typeof type === 'string') {
      return candidate;
    }
  }
  return undefined;
}
