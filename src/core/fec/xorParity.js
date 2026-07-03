export function padBuffer(bytes, paddedLength) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("bytes must be Uint8Array");
  }
  if (!Number.isInteger(paddedLength) || paddedLength < bytes.byteLength) {
    throw new RangeError("paddedLength must be an integer >= bytes length");
  }

  const output = new Uint8Array(paddedLength);
  output.set(bytes);
  return output;
}

export function xorBuffers(buffers, paddedLength) {
  if (!Array.isArray(buffers) || buffers.length === 0) {
    throw new Error("xorBuffers requires at least one buffer");
  }

  const output = new Uint8Array(paddedLength);

  for (const buffer of buffers) {
    const padded = buffer.byteLength === paddedLength ? buffer : padBuffer(buffer, paddedLength);
    for (let i = 0; i < paddedLength; i += 1) {
      output[i] ^= padded[i];
    }
  }

  return output;
}

export function createXorParity(buffers, paddedLength = null) {
  const targetLength = paddedLength ?? Math.max(...buffers.map((buffer) => buffer.byteLength));
  return xorBuffers(buffers, targetLength);
}

export function recoverSingleMissingBuffer({ dataBuffers, parityBuffer, missingIndex, payloadLength, paddedLength }) {
  if (!Array.isArray(dataBuffers) || dataBuffers.length === 0) {
    throw new Error("dataBuffers are required");
  }
  if (!(parityBuffer instanceof Uint8Array)) {
    throw new TypeError("parityBuffer must be Uint8Array");
  }
  if (!Number.isInteger(missingIndex) || missingIndex < 0 || missingIndex >= dataBuffers.length) {
    throw new RangeError("missingIndex is out of range");
  }
  if (!Number.isInteger(payloadLength) || payloadLength < 0 || payloadLength > paddedLength) {
    throw new RangeError("payloadLength is out of range");
  }

  const buffers = [parityBuffer];
  for (let i = 0; i < dataBuffers.length; i += 1) {
    if (i !== missingIndex) {
      const buffer = dataBuffers[i];
      if (!(buffer instanceof Uint8Array)) {
        throw new Error("all known data buffers must be present");
      }
      buffers.push(buffer);
    }
  }

  const recoveredPadded = xorBuffers(buffers, paddedLength);
  return recoveredPadded.slice(0, payloadLength);
}
