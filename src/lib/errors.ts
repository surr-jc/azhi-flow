/**
 * Error classes drive retries (spec section 8): transient failures retry with bounded backoff;
 * authorisation, contract and unsupported-capability failures never retry.
 */
export const ErrorClass = {
  transient: 'transient',
  authorization: 'authorization',
  contractViolation: 'contract_violation',
  unsupportedCapability: 'unsupported_capability',
  invalidInput: 'invalid_input',
  needsOperator: 'needs_operator',
  workerTrustDenied: 'worker_trust_denied',
  budgetExceeded: 'budget_exceeded',
  internal: 'internal',
} as const;
export type ErrorClass = (typeof ErrorClass)[keyof typeof ErrorClass];

export const NON_RETRYABLE: ErrorClass[] = [
  ErrorClass.authorization,
  ErrorClass.contractViolation,
  ErrorClass.unsupportedCapability,
  ErrorClass.invalidInput,
  ErrorClass.needsOperator,
  ErrorClass.workerTrustDenied,
  ErrorClass.budgetExceeded,
];

export class AzhiError extends Error {
  constructor(
    readonly errorClass: ErrorClass,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AzhiError';
  }
}
