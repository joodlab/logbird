/** Unsupported dialect syntax at the start of a query token. Quoted values are scanned separately. */
export const QUERY_DIALECT_PREFIX = /^(?:([\w.]+)\s+(!=|=)\s*("(?:[^"\\]|\\.)*"|[^\s()]+)|(!)(?=[\w.]+:)|(&&|\|\|))/;
