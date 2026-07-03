function normalize(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }

  const output = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined) {
      output[key] = normalize(item);
    }
  }
  return output;
}

export function stableStringify(value) {
  return JSON.stringify(normalize(value));
}
