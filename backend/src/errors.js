// Error shape: { "error": { "code": "CUTOFF_TOO_LOW", "message": "...", "field": "cutoffCm" } }
class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

const E = {
  bad: (code, message, field) => new ApiError(400, code, message, field),
  unauth: (code = 'UNAUTHORIZED', message = 'Login required') => new ApiError(401, code, message),
  forbidden: (code = 'FORBIDDEN', message = 'You do not have access to this') => new ApiError(403, code, message),
  notFound: (code = 'NOT_FOUND', message = 'Not found') => new ApiError(404, code, message),
  conflict: (code, message, field) => new ApiError(409, code, message, field),
  invalid: (code, message, field) => new ApiError(422, code, message, field),
  tooMany: (message = 'Too many attempts, try again later') => new ApiError(429, 'RATE_LIMITED', message),
  notEnabled: (message) => new ApiError(501, 'NOT_ENABLED', message),
};

module.exports = { ApiError, E };
