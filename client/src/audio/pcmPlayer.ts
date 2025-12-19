const DEFAULT_OUTPUT_SAMPLE_RATE = 16000;

export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private monitorGain: GainNode | null = null;
  private monitorDefaultGate: GainNode | null = null;
  private monitorRoutedGate: GainNode | null = null;
  private monitorDestination: MediaStreamAudioDestinationNode | null = null;
  private monitorElement: HTMLAudioElement | null = null;
  private meetGain: GainNode | null = null;
  private micMeetGain: GainNode | null = null;
  private nextTime = 0;
  private scheduled: AudioBufferSourceNode[] = [];
  private sampleRate = DEFAULT_OUTPUT_SAMPLE_RATE;
  private activeTurnId: string | null = null;
  private turnFirstScheduledTime: number | null = null;
  private turnScheduledDurationSec = 0;
  private meetDestination: MediaStreamAudioDestinationNode | null = null;
  private meetElement: HTMLAudioElement | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private monitorEnabled = true;
  private meetEnabled = false;

  ensure(sampleRate: number) {
    this.sampleRate = sampleRate;
    if (!this.ctx) {
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = context;
      this.monitorGain = context.createGain();
      this.monitorGain.gain.value = 1;
      this.monitorDestination = context.createMediaStreamDestination();
      this.monitorDefaultGate = context.createGain();
      this.monitorDefaultGate.gain.value = 1;
      this.monitorDefaultGate.connect(context.destination);

      this.monitorRoutedGate = context.createGain();
      this.monitorRoutedGate.gain.value = 0;
      this.monitorRoutedGate.connect(this.monitorDestination);

      this.monitorGain.connect(this.monitorDefaultGate);
      this.monitorGain.connect(this.monitorRoutedGate);

      this.meetGain = context.createGain();
      this.meetGain.gain.value = 0;
      this.meetDestination = context.createMediaStreamDestination();
      this.meetGain.connect(this.meetDestination);

      this.micMeetGain = context.createGain();
      this.micMeetGain.gain.value = 1;
      this.micMeetGain.connect(this.meetGain);

      if (typeof document !== 'undefined') {
        const monitorEl = document.createElement('audio');
        monitorEl.autoplay = true;
        monitorEl.setAttribute('playsinline', '');
        monitorEl.muted = false;
        monitorEl.style.display = 'none';
        monitorEl.srcObject = this.monitorDestination.stream;
        document.body.appendChild(monitorEl);
        this.monitorElement = monitorEl;

        const el = document.createElement('audio');
        el.autoplay = true;
        el.setAttribute('playsinline', '');
        el.muted = false;
        el.style.display = 'none';
        el.srcObject = this.meetDestination.stream;
        document.body.appendChild(el);
        this.meetElement = el;
      }
      this.nextTime = context.currentTime + 0.05;
    }
    return this.ctx;
  }

  beginTurn(turnId: string) {
    this.activeTurnId = turnId;
    this.turnFirstScheduledTime = null;
    this.turnScheduledDurationSec = 0;
  }

  getPlayedMs() {
    if (!this.ctx || this.turnFirstScheduledTime === null) return 0;
    const playedSec = this.ctx.currentTime - this.turnFirstScheduledTime;
    const clamped = Math.max(0, Math.min(this.turnScheduledDurationSec, playedSec));
    return Math.round(clamped * 1000);
  }

  async setMonitorOutput(
    enabled: boolean,
    deviceId?: string
  ): Promise<{ route: 'off' | 'default' | 'device'; warning?: string }> {
    this.monitorEnabled = enabled;
    if (this.monitorGain) {
      this.monitorGain.gain.value = enabled ? 1 : 0;
    }

    const defaultGate = this.monitorDefaultGate;
    const routedGate = this.monitorRoutedGate;
    const el = this.monitorElement;

    if (!enabled) {
      if (defaultGate) defaultGate.gain.value = 1;
      if (routedGate) routedGate.gain.value = 0;
      el?.pause();
      return { route: 'off' };
    }

    if (!deviceId) {
      if (defaultGate) defaultGate.gain.value = 1;
      if (routedGate) routedGate.gain.value = 0;
      el?.pause();
      return { route: 'default' };
    }

    if (!el) {
      if (defaultGate) defaultGate.gain.value = 1;
      if (routedGate) routedGate.gain.value = 0;
      return { route: 'default' };
    }

    const media = el as HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };
    if (typeof media.setSinkId !== 'function') {
      if (defaultGate) defaultGate.gain.value = 1;
      if (routedGate) routedGate.gain.value = 0;
      el.pause();
      return {
        route: 'default',
        warning: '選択した出力デバイスに再生できないため、システム既定の出力で再生します。',
      };
    }

    try {
      await media.setSinkId(deviceId);
    } catch (err) {
      console.warn('monitor setSinkId failed', err);
      if (defaultGate) defaultGate.gain.value = 1;
      if (routedGate) routedGate.gain.value = 0;
      el.pause();
      return {
        route: 'default',
        warning: '出力デバイスの切り替えに失敗したため、システム既定の出力で再生します。',
      };
    }

    if (defaultGate) defaultGate.gain.value = 0;
    if (routedGate) routedGate.gain.value = 1;
    try {
      await el.play();
    } catch (err) {
      console.warn('monitor playback failed', err);
      if (defaultGate) defaultGate.gain.value = 1;
      if (routedGate) routedGate.gain.value = 0;
      el.pause();
      return {
        route: 'default',
        warning: '出力デバイスでの再生に失敗したため、システム既定の出力で再生します。',
      };
    }
    return { route: 'device' };
  }

  async setMeetOutput(enabled: boolean, deviceId?: string) {
    this.meetEnabled = enabled;
    if (this.meetGain) {
      this.meetGain.gain.value = enabled ? 1 : 0;
    }
    const el = this.meetElement;
    if (!el) return;

    if (enabled && deviceId) {
      const media = el as HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };
      if (typeof media.setSinkId !== 'function') {
        throw new Error('このブラウザは setSinkId に未対応です（Meet への音声出力には Chrome/Edge 推奨）');
      }
      await media.setSinkId(deviceId);
    }

    if (enabled) {
      try {
        await el.play();
      } catch (err) {
        const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
        throw new Error(`Meet 出力の再生開始に失敗しました${detail}`);
      }
    } else {
      el.pause();
    }
  }

  setMicStream(stream: MediaStream | null, opts?: { toMeet?: boolean }) {
    if (!this.ctx) return;
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        // ignore
      }
      this.micSource = null;
    }
    if (!stream) return;
    const source = this.ctx.createMediaStreamSource(stream);
    this.micSource = source;
    if (opts?.toMeet && this.micMeetGain) {
      source.connect(this.micMeetGain);
    }
  }

  setMeetMicMuted(muted: boolean) {
    if (!this.micMeetGain) return;
    this.micMeetGain.gain.value = muted ? 0 : 1;
  }

  enqueuePcm(buffer: ArrayBuffer) {
    if (!this.ctx || !this.monitorGain || !this.meetGain) return;
    const ctx = this.ctx;
    const pcm = new Int16Array(buffer);
    if (pcm.length === 0) return;
    const float32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) {
      float32[i] = pcm[i] / 32768;
    }
    const audioBuffer = ctx.createBuffer(1, float32.length, this.sampleRate);
    audioBuffer.copyToChannel(float32, 0);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    if (this.monitorEnabled) {
      source.connect(this.monitorGain);
    }
    if (this.meetEnabled) {
      source.connect(this.meetGain);
    }
    const now = ctx.currentTime;
    if (this.nextTime < now + 0.02) {
      this.nextTime = now + 0.02;
    }
    if (this.activeTurnId && this.turnFirstScheduledTime === null) {
      this.turnFirstScheduledTime = this.nextTime;
    }
    source.start(this.nextTime);
    this.nextTime += audioBuffer.duration;
    if (this.activeTurnId) {
      this.turnScheduledDurationSec += audioBuffer.duration;
    }
    this.scheduled.push(source);
    source.onended = () => {
      this.scheduled = this.scheduled.filter((n) => n !== source);
    };
    void ctx.resume().catch(() => undefined);
  }

  clear() {
    this.scheduled.forEach((node) => {
      try {
        node.stop();
      } catch {
        // ignore
      }
    });
    this.scheduled = [];
    this.activeTurnId = null;
    this.turnFirstScheduledTime = null;
    this.turnScheduledDurationSec = 0;
    if (this.ctx) {
      this.nextTime = this.ctx.currentTime + 0.02;
    }
  }

  async close() {
    this.clear();
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        // ignore
      }
      this.micSource = null;
    }
    if (this.monitorElement) {
      const el = this.monitorElement;
      this.monitorElement = null;
      try {
        el.pause();
      } catch {
        // ignore
      }
      try {
        el.srcObject = null;
      } catch {
        // ignore
      }
      try {
        el.remove();
      } catch {
        // ignore
      }
    }
    if (this.meetElement) {
      const el = this.meetElement;
      this.meetElement = null;
      try {
        el.pause();
      } catch {
        // ignore
      }
      try {
        el.srcObject = null;
      } catch {
        // ignore
      }
      try {
        el.remove();
      } catch {
        // ignore
      }
    }
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      this.monitorGain = null;
      this.monitorDefaultGate = null;
      this.monitorRoutedGate = null;
      this.monitorDestination = null;
      this.meetGain = null;
      this.micMeetGain = null;
      this.meetDestination = null;
      await ctx.close().catch(() => undefined);
    }
  }
}

export { DEFAULT_OUTPUT_SAMPLE_RATE };
