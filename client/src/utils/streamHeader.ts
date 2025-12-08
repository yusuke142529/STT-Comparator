// Shared binary header spec for realtime PCM frames.
// Fields (little-endian):
// - seq:        uint32   (0-3)
// - captureTs:  float64  (4-11)  wall-clock ms
// - durationMs: float32  (12-15) chunk duration in milliseconds
export const STREAM_HEADER_BYTES = 16;
