export class LodestarError extends Error {
  constructor(code, message, { cause, detail = {} } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LodestarError";
    this.code = code;
    this.detail = detail;
  }
}

export function wrapError(error, code, message, detail = {}) {
  if (error instanceof LodestarError && error.code === code) return error;
  return new LodestarError(code, message, {
    cause: error,
    detail: {
      ...detail,
      cause_code: typeof error?.code === "string" ? error.code : null,
    },
  });
}

export function errorResult(error) {
  if (error instanceof LodestarError) {
    return {
      code: error.code,
      message: error.message,
      detail: error.detail,
    };
  }
  return {
    code: "internal-error",
    message: "Lodestar encountered an unexpected error",
    detail: {
      cause_code: typeof error?.code === "string" ? error.code : null,
      reason: typeof error?.message === "string"
        ? error.message
        : "unknown error",
    },
  };
}
