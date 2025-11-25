import { useCallback, useEffect, useRef, useState } from 'react';

export type MicrophonePermissionStatus = 'unknown' | 'prompt' | 'granted' | 'denied';

const mapPermissionState = (state: PermissionState | string | undefined): MicrophonePermissionStatus => {
  if (state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  return 'prompt';
};

export function useMicrophonePermission() {
  const [status, setStatus] = useState<MicrophonePermissionStatus>('unknown');
  const permissionRef = useRef<PermissionStatus | null>(null);

  const handlePermissionChange = useCallback(() => {
    if (!permissionRef.current) return;
    setStatus(mapPermissionState(permissionRef.current.state));
  }, []);

  const queryPermission = useCallback(async () => {
    if (typeof navigator === 'undefined') {
      setStatus('unknown');
      return;
    }
    if (!('permissions' in navigator)) {
      setStatus('prompt');
      return;
    }

    try {
      const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (permissionRef.current) {
        permissionRef.current.onchange = null;
      }
      permissionRef.current = permission;
      permission.onchange = handlePermissionChange;
      setStatus(mapPermissionState(permission.state));
    } catch {
      setStatus('prompt');
    }
  }, [handlePermissionChange]);

  useEffect(() => {
    void queryPermission();
    return () => {
      if (permissionRef.current) {
        permissionRef.current.onchange = null;
      }
    };
  }, [queryPermission]);

  return { status, refresh: queryPermission };
}
