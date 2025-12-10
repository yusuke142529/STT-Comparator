import { memo } from 'react';

interface ToggleSwitchProps {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  helperText?: string;
}

export const ToggleSwitch = memo(({ label, checked, onChange, disabled, helperText }: ToggleSwitchProps) => (
  <label className={`toggle-switch ${disabled ? 'disabled' : ''}`}>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
    <span className="toggle-switch__track">
      <span className="toggle-switch__thumb" />
    </span>
    <span>
      {label}
      {helperText && <span className="helper-text" style={{ display: 'block' }}>{helperText}</span>}
    </span>
  </label>
));
