const TABLE = new Uint32Array(256);

for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  TABLE[i] = c >>> 0;
}

function toBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }

  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }

  throw new TypeError("crc32 input must be a string or Uint8Array");
}

export function crc32(input) {
  const bytes = toBytes(input);
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32Hex(input) {
  return crc32(input).toString(16).padStart(8, "0");
}
