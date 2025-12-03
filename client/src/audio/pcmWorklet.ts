/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable max-classes-per-file */

const TARGET_BITS_PER_SAMPLE = 16;

type ProcessorOptions = {
  chunkSamples: number;
};

class PcmWorkletProcessor extends AudioWorkletProcessor {
  private readonly chunkSamples: number;
  private buffer: Float32Array;
  private pendingSamples = 0;
  private seq = 0;
  private totalSamples = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const opts = (options.processorOptions || {}) as ProcessorOptions;
    this.chunkSamples = Math.max(1, Math.trunc(opts.chunkSamples ?? 4000));
    this.buffer = new Float32Array(this.chunkSamples * 2);
  }

  private ensureCapacity(nextNeeded: number) {
    if (nextNeeded <= this.buffer.length) return;
    const next = new Float32Array(nextNeeded * 2);
    next.set(this.buffer.subarray(0, this.pendingSamples));
    this.buffer = next;
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const channels = input;
    const frames = channels[0]?.length ?? 0;
    if (frames === 0) return true;

    this.ensureCapacity(this.pendingSamples + frames);

    for (let i = 0; i < frames; i += 1) {
      let sample = 0;
      const channelCount = channels.length;
      for (let ch = 0; ch < channelCount; ch += 1) {
        sample += channels[ch][i] ?? 0;
      }
      sample /= channelCount || 1;
      this.buffer[this.pendingSamples + i] = sample;
    }
    this.pendingSamples += frames;

    while (this.pendingSamples >= this.chunkSamples) {
      const chunk = this.buffer.subarray(0, this.chunkSamples);
      const pcm = new ArrayBuffer(this.chunkSamples * (TARGET_BITS_PER_SAMPLE / 8));
      const view = new DataView(pcm);
      for (let i = 0; i < chunk.length; i += 1) {
        let s = chunk[i];
        s = Math.max(-1, Math.min(1, s));
        view.setInt16(i * 2, s * 0x7fff, true);
      }

      const durationMs = (this.chunkSamples / sampleRate) * 1000;
      this.totalSamples += this.chunkSamples;
      const endTimeMs = (this.totalSamples / sampleRate) * 1000;

      this.port.postMessage({
        seq: this.seq,
        pcm,
        durationMs,
        endTimeMs,
      });
      this.seq += 1;

      // shift remaining samples
      const remaining = this.pendingSamples - this.chunkSamples;
      if (remaining > 0) {
        this.buffer.copyWithin(0, this.chunkSamples, this.pendingSamples);
      }
      this.pendingSamples = remaining;
    }

    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorkletProcessor);
