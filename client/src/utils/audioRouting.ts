import type { AudioInputDevice } from '../hooks/useAudioInputDevices';
import type { AudioOutputDevice } from '../hooks/useAudioOutputDevices';

type AudioRoutingOptions = {
  monitorAssistant: boolean;
  monitorOutputDeviceId?: string;
  enableMeetOutput: boolean;
  meetOutputDeviceId?: string;
  micDeviceId?: string;
  audioOutputs: AudioOutputDevice[];
  audioInputs: AudioInputDevice[];
};

export type AudioRoutingDecision = {
  effectiveMonitorAssistant: boolean;
  allowMicToMeet: boolean;
  warnings: string[];
};

const DEFAULT_OUTPUT_DEVICE_ID = 'default';

const normalizeId = (value?: string) => value?.trim() || '';

const resolveOutputGroupId = (deviceId: string | undefined, outputs: AudioOutputDevice[]) => {
  if (!outputs.length) return null;
  const id = normalizeId(deviceId) || DEFAULT_OUTPUT_DEVICE_ID;
  const device = outputs.find((d) => d.deviceId === id);
  const groupId = device?.groupId?.trim();
  return groupId || null;
};

const resolveInputGroupId = (deviceId: string | undefined, inputs: AudioInputDevice[]) => {
  if (!deviceId) return null;
  const device = inputs.find((d) => d.deviceId === deviceId);
  const groupId = device?.groupId?.trim();
  return groupId || null;
};

export const computeVoiceRouting = (options: AudioRoutingOptions): AudioRoutingDecision => {
  const warnings: string[] = [];
  const monitorAssistant = options.monitorAssistant;
  const enableMeetOutput = options.enableMeetOutput;

  let effectiveMonitorAssistant = monitorAssistant;
  let allowMicToMeet = enableMeetOutput;

  if (monitorAssistant && enableMeetOutput) {
    const monitorId = normalizeId(options.monitorOutputDeviceId) || DEFAULT_OUTPUT_DEVICE_ID;
    const meetId = normalizeId(options.meetOutputDeviceId) || DEFAULT_OUTPUT_DEVICE_ID;
    const sameDeviceId = monitorId && meetId && monitorId === meetId;
    const monitorGroupId = resolveOutputGroupId(options.monitorOutputDeviceId, options.audioOutputs);
    const meetGroupId = resolveOutputGroupId(options.meetOutputDeviceId, options.audioOutputs);
    const sameGroup = monitorGroupId && meetGroupId && monitorGroupId === meetGroupId;
    if (sameDeviceId || sameGroup) {
      effectiveMonitorAssistant = false;
      warnings.push('Meet 出力とモニタ出力が同一デバイスのため、モニタ再生を自動OFFしました。');
    }
  }

  if (enableMeetOutput) {
    const meetGroupId = resolveOutputGroupId(options.meetOutputDeviceId, options.audioOutputs);
    const micGroupId = resolveInputGroupId(options.micDeviceId, options.audioInputs);
    if (meetGroupId && micGroupId && meetGroupId === micGroupId) {
      allowMicToMeet = false;
      warnings.push('マイク入力と Meet 出力が同一デバイスのため、Meet への自分の声のミックスを停止しました。');
    }
  }

  return {
    effectiveMonitorAssistant,
    allowMicToMeet,
    warnings,
  };
};
