import { describe, expect, it } from 'vitest';
import { computeVoiceRouting } from './audioRouting';

const outputs = [
  { deviceId: 'default', label: 'Default', groupId: 'group-default' },
  { deviceId: 'meet-out', label: 'Meet Out', groupId: 'group-meet' },
  { deviceId: 'monitor-out', label: 'Monitor Out', groupId: 'group-meet' },
];

const inputs = [
  { deviceId: 'mic-1', label: 'Mic', groupId: 'group-mic' },
  { deviceId: 'loopback', label: 'Loopback', groupId: 'group-meet' },
];

describe('computeVoiceRouting', () => {
  it('disables monitor when meet output shares the same group', () => {
    const result = computeVoiceRouting({
      monitorAssistant: true,
      monitorOutputDeviceId: 'monitor-out',
      enableMeetOutput: true,
      meetOutputDeviceId: 'meet-out',
      micDeviceId: 'mic-1',
      audioOutputs: outputs,
      audioInputs: inputs,
    });

    expect(result.effectiveMonitorAssistant).toBe(false);
    expect(result.warnings.some((w) => w.includes('モニタ再生'))).toBe(true);
  });

  it('keeps monitor enabled when outputs are different', () => {
    const result = computeVoiceRouting({
      monitorAssistant: true,
      monitorOutputDeviceId: 'monitor-out',
      enableMeetOutput: true,
      meetOutputDeviceId: 'default',
      micDeviceId: 'mic-1',
      audioOutputs: outputs,
      audioInputs: inputs,
    });

    expect(result.effectiveMonitorAssistant).toBe(true);
  });

  it('disables mic mix when mic group equals meet output group', () => {
    const result = computeVoiceRouting({
      monitorAssistant: false,
      enableMeetOutput: true,
      meetOutputDeviceId: 'meet-out',
      micDeviceId: 'loopback',
      audioOutputs: outputs,
      audioInputs: inputs,
    });

    expect(result.allowMicToMeet).toBe(false);
    expect(result.warnings.some((w) => w.includes('ミックス'))).toBe(true);
  });
});
