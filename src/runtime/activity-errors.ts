import { ApplicationFailure } from '@temporalio/common';
import { AzhiError, ErrorClass, NON_RETRYABLE } from '../lib/errors.js';

/** Converts thrown errors into ApplicationFailures typed by error class, so retry policy applies. */
export function toFailure(err: unknown): ApplicationFailure {
  if (err instanceof ApplicationFailure) return err;
  if (err instanceof AzhiError) {
    return ApplicationFailure.create({
      type: err.errorClass,
      message: err.message,
      nonRetryable: NON_RETRYABLE.includes(err.errorClass),
      details: err.details ? [err.details] : undefined,
    });
  }
  return ApplicationFailure.create({ type: ErrorClass.transient, message: (err as Error)?.message ?? String(err) });
}
