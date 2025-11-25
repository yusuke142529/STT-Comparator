import { useCallback, useEffect, useMemo, useState } from 'react';

export interface AudioInputDevice {
  deviceId: string;
  label: string;
  groupId: string;
}

const mapLabel = (deviceLabel: string, index: number) => {
  if (deviceLabel) return deviceLabel;
  return `マイク ${index + 1} (許可後に名称表示)`;
};

export function useAudioInputDevices() {
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      setDevices([]);
      setError('このブラウザではマイク一覧が取得できません');
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = list.filter((device) => device.kind === 'audioinput');
      setDevices(
        audioInputs.map((device, index) => ({
          deviceId: device.deviceId,
          label: mapLabel(device.label, index),
          groupId: device.groupId,
        }))
      );
      setError(null);
    } catch (err) {
      console.error('audio input enumeration failed', err);
      setError('マイク候補を取得できませんでした');
      setDevices([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
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

  return { devices, loading, error, hasDevices, refresh };
}
