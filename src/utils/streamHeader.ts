export const STREAM_HEADER_BYTES = 16; // seq(uint32) + captureTs(float64) + durationMs(float32)

export type StreamHeader = {
  seq: number;
  captureTs: number;
  durationMs: number;
};

export type ParsedStreamFrame = {
  header: StreamHeader;
  pcm: Buffer;
};

export function parseStreamFrame(buffer: Buffer): ParsedStreamFrame {
  if (buffer.length <= STREAM_HEADER_BYTES) {
    throw new Error('invalid pcm frame');
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const seq = view.getUint32(0, true);
  const captureTs = view.getFloat64(4, true);
  const durationMs = view.getFloat32(12, true);
  const pcm = buffer.subarray(STREAM_HEADER_BYTES);
  return { header: { seq, captureTs, durationMs }, pcm };
}
