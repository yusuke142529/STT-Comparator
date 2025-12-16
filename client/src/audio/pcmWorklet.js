/* eslint-disable max-classes-per-file */

const TARGET_BITS_PER_SAMPLE = 16;

class PcmWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options?.processorOptions ?? {});
    this.chunkSamples = Math.max(1, Math.trunc(opts.chunkSamples ?? 4000));
    this.channelSplit = !!opts.channelSplit;
    this.buffer = new Float32Array(this.chunkSamples * 2);
    this.leftBuffer = this.channelSplit ? new Float32Array(this.chunkSamples * 2) : null;
    this.rightBuffer = this.channelSplit ? new Float32Array(this.chunkSamples * 2) : null;
    this.pendingSamples = 0;
    this.seq = 0;
    this.totalSamples = 0;
  }

  ensureCapacity(nextNeeded) {
    if (nextNeeded <= this.buffer.length) return;
    const next = new Float32Array(nextNeeded * 2);
    next.set(this.buffer.subarray(0, this.pendingSamples));
    this.buffer = next;
    if (this.channelSplit && this.leftBuffer && this.rightBuffer) {
      const nextLeft = new Float32Array(nextNeeded * 2);
      nextLeft.set(this.leftBuffer.subarray(0, this.pendingSamples));
      this.leftBuffer = nextLeft;
      const nextRight = new Float32Array(nextNeeded * 2);
      nextRight.set(this.rightBuffer.subarray(0, this.pendingSamples));
      this.rightBuffer = nextRight;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const channels = input;
    const frames = channels[0]?.length ?? 0;
    if (frames === 0) return true;

    this.ensureCapacity(this.pendingSamples + frames);

    if (this.channelSplit && this.leftBuffer && this.rightBuffer) {
      for (let i = 0; i < frames; i += 1) {
        const left = channels[0]?.[i] ?? 0;
        const right = channels[1]?.[i] ?? left;
        this.leftBuffer[this.pendingSamples + i] = left;
        this.rightBuffer[this.pendingSamples + i] = right;
      }
      this.pendingSamples += frames;
    } else {
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
    }

    while (this.pendingSamples >= this.chunkSamples) {
      if (this.channelSplit && this.leftBuffer && this.rightBuffer) {
        const leftChunk = this.leftBuffer.subarray(0, this.chunkSamples);
        const rightChunk = this.rightBuffer.subarray(0, this.chunkSamples);
        const pcmLeft = new ArrayBuffer(this.chunkSamples * (TARGET_BITS_PER_SAMPLE / 8));
        const pcmRight = new ArrayBuffer(this.chunkSamples * (TARGET_BITS_PER_SAMPLE / 8));
        const viewL = new DataView(pcmLeft);
        const viewR = new DataView(pcmRight);
        for (let i = 0; i < this.chunkSamples; i += 1) {
          let l = leftChunk[i];
          let r = rightChunk[i];
          l = Math.max(-1, Math.min(1, l));
          r = Math.max(-1, Math.min(1, r));
          viewL.setInt16(i * 2, l * 0x7fff, true);
          viewR.setInt16(i * 2, r * 0x7fff, true);
        }

        const durationMs = (this.chunkSamples / sampleRate) * 1000;
        this.totalSamples += this.chunkSamples;
        const endTimeMs = (this.totalSamples / sampleRate) * 1000;

        this.port.postMessage({
          seq: this.seq,
          pcmLeft,
          pcmRight,
          durationMs,
          endTimeMs,
          channelSplit: true,
        });
        this.seq += 1;

        const remaining = this.pendingSamples - this.chunkSamples;
        if (remaining > 0) {
          this.leftBuffer.copyWithin(0, this.chunkSamples, this.pendingSamples);
          this.rightBuffer.copyWithin(0, this.chunkSamples, this.pendingSamples);
        }
        this.pendingSamples = remaining;
      } else {
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

        const remaining = this.pendingSamples - this.chunkSamples;
        if (remaining > 0) {
          this.buffer.copyWithin(0, this.chunkSamples, this.pendingSamples);
        }
        this.pendingSamples = remaining;
      }
    }

    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorkletProcessor);
