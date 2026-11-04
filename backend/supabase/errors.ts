export type ErrorCode = 'invalid-argument' | 'unauthenticated' | 'not-found' | 'failed-precondition' | 'resource-exhausted' | 'unavailable' | 'internal'
export class ServiceError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); this.name = 'ServiceError' }
}
