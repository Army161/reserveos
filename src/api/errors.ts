/**
 * API error model.
 *
 * Responses follow RFC 9457 (problem+json). Two rules matter more than the
 * format:
 *
 *  - A client error says exactly what is wrong so an operator can fix it.
 *  - A server error says nothing beyond a correlation id. Stack traces, SQL
 *    fragments and constraint names describe the schema of a system holding
 *    banks' reserve positions, and none of that belongs in an HTTP response.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
    readonly type = 'about:blank',
  ) {
    super(detail);
    this.name = 'ApiError';
  }
}

export const badRequest = (detail: string): ApiError =>
  new ApiError(400, 'Bad Request', detail, 'https://reserveos.dev/problems/bad-request');

export const unauthorized = (detail = 'Authentication required'): ApiError =>
  new ApiError(401, 'Unauthorized', detail, 'https://reserveos.dev/problems/unauthorized');

export const forbidden = (detail: string): ApiError =>
  new ApiError(403, 'Forbidden', detail, 'https://reserveos.dev/problems/forbidden');

export const notFound = (detail = 'Not found'): ApiError =>
  new ApiError(404, 'Not Found', detail, 'https://reserveos.dev/problems/not-found');

export const conflict = (detail: string): ApiError =>
  new ApiError(409, 'Conflict', detail, 'https://reserveos.dev/problems/conflict');

export const unprocessable = (detail: string): ApiError =>
  new ApiError(422, 'Unprocessable Entity', detail, 'https://reserveos.dev/problems/unprocessable');

export interface ProblemDocument {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly correlationId?: string;
}

export function toProblem(error: unknown, correlationId: string): ProblemDocument {
  if (error instanceof ApiError) {
    return {
      type: error.type,
      title: error.title,
      status: error.status,
      detail: error.detail,
      correlationId,
    };
  }

  // Deliberately opaque. The real cause is logged against the same id.
  return {
    type: 'https://reserveos.dev/problems/internal',
    title: 'Internal Server Error',
    status: 500,
    detail: 'The request could not be completed. Quote the correlation id when reporting this.',
    correlationId,
  };
}
