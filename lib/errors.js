/**
 * @file errors.js
 * @description Custom structured error classes for production-grade error handling.
 */

class ListerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || 'INTERNAL_ERROR';
    this.status = options.status || 500;
    this.traceId = options.traceId || null;
    this.details = options.details || null;
    this.originalError = options.originalError || null;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      status: this.status,
      traceId: this.traceId,
      details: this.details
    };
  }
}

class EbayApiError extends ListerError {
  constructor(message, options = {}) {
    super(message, {
      code: options.code || 'EBAY_API_ERROR',
      status: options.status || 502,
      ...options
    });
    this.ebayErrorCode = options.ebayErrorCode || null;
    this.ebayTraceId = options.ebayTraceId || null;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      ebayErrorCode: this.ebayErrorCode,
      ebayTraceId: this.ebayTraceId
    };
  }
}

class GeminiApiError extends ListerError {
  constructor(message, options = {}) {
    super(message, {
      code: options.code || 'GEMINI_API_ERROR',
      status: options.status || 502,
      ...options
    });
  }
}

class CrossPostError extends ListerError {
  constructor(message, options = {}) {
    super(message, {
      code: options.code || 'CROSS_POST_ERROR',
      status: options.status || 502,
      ...options
    });
    this.platform = options.platform || 'unknown';
    this.sku = options.sku || null;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      platform: this.platform,
      sku: this.sku
    };
  }
}

class FileSystemError extends ListerError {
  constructor(message, options = {}) {
    super(message, {
      code: options.code || 'FS_ERROR',
      status: options.status || 500,
      ...options
    });
    this.path = options.path || null;
    this.action = options.action || 'unknown';
  }

  toJSON() {
    return {
      ...super.toJSON(),
      path: this.path,
      action: this.action
    };
  }
}

module.exports = {
  ListerError,
  EbayApiError,
  GeminiApiError,
  CrossPostError,
  FileSystemError
};
