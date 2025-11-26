import { memo } from 'react';

interface ToggleSwitchProps {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

export const ToggleSwitch = memo(({ label, checked, onChange }: ToggleSwitchProps) => (
  <label className="toggle-switch">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <span className="toggle-switch__track">
      <span className="toggle-switch__thumb" />
    </span>
    <span>{label}</span>
  </label>
));
