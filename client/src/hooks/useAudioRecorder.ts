import { useEffect, useMemo, useState } from 'react';
import { useAudioInputDevices } from './useAudioInputDevices';
import { useMicrophonePermission } from './useMicrophonePermission';
import type { MicrophonePermissionStatus } from './useMicrophonePermission';

export const useAudioRecorder = () => {
  const { devices, hasDevices, loading, error, refresh } = useAudioInputDevices();
  const { status, refresh: refreshMicPermission } = useMicrophonePermission();
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedAudioDeviceId((current) => {
      if (current && devices.some((device) => device.deviceId === current)) return current;
      return devices[0]?.deviceId ?? null;
    });
  }, [devices]);

  const selectedAudioDeviceLabel = useMemo(() => {
    if (!selectedAudioDeviceId) return '未選択';
    return devices.find((device) => device.deviceId === selectedAudioDeviceId)?.label ?? '選択中のマイク';
  }, [devices, selectedAudioDeviceId]);

  return {
    devices,
    hasDevices,
    loading,
    error,
    refreshDevices: refresh,
    selectedAudioDeviceId,
    setSelectedAudioDeviceId,
    selectedAudioDeviceLabel,
    micPermission: status as MicrophonePermissionStatus,
    refreshMicPermission,
  };
};
