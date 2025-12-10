import { useCallback, useEffect, useMemo, useState } from 'react';

export interface AudioOutputDevice {
  deviceId: string;
  label: string;
  groupId: string;
}

const mapLabel = (deviceLabel: string, index: number) => {
  if (deviceLabel) return deviceLabel;
  return `スピーカー ${index + 1} (許可後に名称表示)`;
};

export function useAudioOutputDevices() {
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);

  const refresh = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      setDevices([]);
      setError('このブラウザでは出力候補が取得できません');
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const audioOutputs = list.filter((device) => device.kind === 'audiooutput');
      setDevices(
        audioOutputs.map((device, index) => ({
          deviceId: device.deviceId,
          label: mapLabel(device.label, index),
          groupId: device.groupId,
        }))
      );
      setError(null);
    } catch (err) {
      console.error('audio output enumeration failed', err);
      setDevices([]);
      setError('出力先の候補を取得できませんでした');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      setLoading(false);
      return;
    }

    void refresh();
    const handleDeviceChange = () => {
      void refresh();
    };
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [refresh]);

  const hasDevices = useMemo(() => devices.length > 0, [devices]);

  const requestSelectAudioOutput = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      setError('ブラウザが出力デバイス選択に対応していません');
      return false;
    }
    const mediaDevices = navigator.mediaDevices as MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
    const selector = mediaDevices.selectAudioOutput;
    if (typeof selector !== 'function') {
      setError('このブラウザは出力デバイス選択 API に未対応です');
      return false;
    }
    setSelecting(true);
    try {
      await selector.call(mediaDevices);
      await refresh();
      setError(null);
      return true;
    } catch (err) {
      console.error('selectAudioOutput failed', err);
      setError((err as DOMException)?.message ?? '出力デバイスの許可に失敗しました');
      return false;
    } finally {
      setSelecting(false);
    }
  }, [refresh]);

  return { devices, loading, error, hasDevices, refresh, requestSelectAudioOutput, selecting };
}
