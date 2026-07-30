function canonicalValue(value, omit) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalValue(entry, omit));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !omit.has(key) && value[key] !== undefined)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => [key, canonicalValue(value[key], omit)]),
    );
  }
  return value;
}

export function canonicalStringify(value, { omit = new Set() } = {}) {
  return JSON.stringify(canonicalValue(value, omit));
}
