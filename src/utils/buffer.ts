export function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const slice = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  if (slice instanceof ArrayBuffer) {
    return slice;
  }
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}
