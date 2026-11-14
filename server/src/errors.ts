import type { ApiError } from '@outreach/shared';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiError['code'],
    message: string,
  ) {
    super(message);
  }
}
