export const STYLES = `:root {
  /* ------------------------------------------------------------------
   * DESIGN TOKENS
   * ------------------------------------------------------------------ */

  /* Palette: Primary (Indigo) */
  --c-primary: #6366f1;
  --c-primary-hover: #4f46e5;
  --c-primary-active: #4338ca;
  --c-primary-soft: #e0e7ff;
  --c-primary-alpha: rgba(99, 102, 241, 0.15);

  /* Palette: Surface & Background */
  --c-surface: #ffffff;
  --c-surface-soft: #f8fafc;
  --c-surface-deep: #f1f5f9;
  --c-overlay: rgba(255, 255, 255, 0.9);

  /* Palette: Text */
  --c-text: #0f172a;
  --c-text-muted: #475569;
  --c-text-subtle: #94a3b8;
  --c-text-inverse: #ffffff;

  /* Palette: Status indicators */
  --c-border: #e2e8f0;
  --c-success: #10b981;
  --c-warning: #f59e0b;
  --c-error: #ef4444;

  /* Dimensions & Shapes */
  --radius: 12px;
  --radius-lg: 20px;
  --radius-pill: 9999px;
  --panel-gap: 1.5rem;
  --header-height: 72px;

  /* Depth & Shadows (Layered System) */
  --shadow-sm: 0 1px 2px 0 rgba(15, 23, 42, 0.05);
  --shadow-card: 0 4px 6px -1px rgba(15, 23, 42, 0.05), 0 2px 4px -1px rgba(15, 23, 42, 0.03);
  --shadow-float: 0 20px 25px -5px rgba(15, 23, 42, 0.1), 0 10px 10px -5px rgba(15, 23, 42, 0.04);
  --shadow-focus: 0 0 0 3px rgba(99, 102, 241, 0.35);
  --shadow-glow: 0 0 20px rgba(99, 102, 241, 0.25);

  /* Animations */
  --ease-standard: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
  --duration-fast: 0.2s;
  --duration-normal: 0.3s;

  /* Typography */
  --font-base: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: "JetBrains Mono", "IBM Plex Mono", "SF Mono", Consolas, monospace;

  /* Z-Index Layers */
  --z-base: 0;
  --z-sticky: 100;
  --z-header: 200;
  --z-overlay: 900;
  --z-modal: 1000;
}

/* ------------------------------------------------------------------
 * RESET & GLOBAL STYLES
 * ------------------------------------------------------------------ */

*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
  height: 100%;
}

body {
  margin: 0;
  min-height: 100vh;
  background-color: var(--c-surface-soft);
  color: var(--c-text);
  font-family: var(--font-base);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* Custom Scrollbar */
::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 5px;
  border: 3px solid var(--c-surface-soft);
}
::-webkit-scrollbar-thumb:hover {
  background: #94a3b8;
}

::selection {
  background: var(--c-primary-soft);
  color: var(--c-primary-active);
}

#root {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

/* ------------------------------------------------------------------
 * LAYOUT STRUCTURE
 * ------------------------------------------------------------------ */

.app-shell {
  width: min(1200px, 94%);
  margin: 0 auto;
  padding: 1.5rem 1rem 7rem; /* Bottom padding for floating footer */
  display: flex;
  flex-direction: column;
  gap: 2rem;
  flex: 1;
}

.batch-layout {
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

/* ------------------------------------------------------------------
 * HEADER COMPONENT (Glassmorphism)
 * ------------------------------------------------------------------ */

.glass-header {
  position: sticky;
  top: 1rem;
  z-index: var(--z-header);
  background: var(--c-overlay); /* Fallback */
  border: 1px solid rgba(255, 255, 255, 0.6);
  border-radius: var(--radius-lg);
  padding: 0.75rem 1.5rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1.5rem;
  box-shadow: var(--shadow-sm);
  transition: all var(--duration-normal) var(--ease-standard);
}

@supports (backdrop-filter: blur(16px)) or (-webkit-backdrop-filter: blur(16px)) {
  .glass-header {
    background: rgba(255, 255, 255, 0.75);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid rgba(255, 255, 255, 0.4);
  }
}

.app-title h1 {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, #0f172a 30%, var(--c-primary) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.app-title p {
  margin: 0;
  color: var(--c-text-muted);
  font-size: 0.85rem;
  font-weight: 500;
}

.subtitle {
  color: var(--c-text-muted);
  font-size: 0.85rem;
  margin-top: 0.35rem;
}

/* ------------------------------------------------------------------
 * NAVIGATION TABS
 * ------------------------------------------------------------------ */

.tabs {
  position: relative;
  display: grid;
  grid-template-columns: repeat(var(--tabs, 3), 1fr);
  background: var(--c-surface-soft);
  border-radius: var(--radius);
  padding: 0.3rem;
  border: 1px solid rgba(15, 23, 42, 0.05);
  isolation: isolate;
}

.tab-indicator {
  position: absolute;
  top: 0.3rem;
  bottom: 0.3rem;
  width: calc((100% - 0.6rem) / var(--tabs, 3));
  left: calc(0.3rem + (var(--active-tab, 0) * ((100% - 0.6rem) / var(--tabs, 3))));
  background: var(--c-surface);
  border-radius: calc(var(--radius) * 0.8);
  box-shadow: var(--shadow-sm);
  transition: left 0.35s var(--ease-standard);
  z-index: 1;
}

.tab-button {
  position: relative;
  z-index: 2;
  border: none;
  background: transparent;
  padding: 0.6rem 0.5rem;
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--c-text-muted);
  border-radius: calc(var(--radius) * 0.8);
  cursor: pointer;
  transition: color 0.2s ease;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}

.tab-button[aria-current='page'] {
  color: var(--c-primary);
}

.tab-button:hover:not([aria-current='page']) {
  color: var(--c-text);
}

/* ------------------------------------------------------------------
 * CARDS & BANNERS
 * ------------------------------------------------------------------ */

.card {
  background: var(--c-surface);
  border-radius: var(--radius-lg);
  padding: 2rem;
  border: 1px solid rgba(15, 23, 42, 0.06);
  box-shadow: var(--shadow-card);
  transition: transform 0.3s var(--ease-standard), box-shadow 0.3s var(--ease-standard);
}

.card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-float);
  border-color: rgba(99, 102, 241, 0.1);
}

.banner {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.5rem;
  border-radius: var(--radius);
  border: 1px solid transparent;
  background: var(--c-surface);
  box-shadow: var(--shadow-sm);
  font-size: 0.95rem;
  animation: floatIn 0.4s var(--ease-out);
}

.banner.warning {
  border-color: rgba(245, 158, 11, 0.2);
  background: #fffbeb;
  color: #92400e;
}

.banner.error {
  border-color: rgba(239, 68, 68, 0.2);
  background: #fef2f2;
  color: #991b1b;
}

/* ------------------------------------------------------------------
 * BUTTONS & CONTROLS
 * ------------------------------------------------------------------ */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-pill);
  padding: 0.75rem 1.5rem;
  font-weight: 600;
  font-size: 0.95rem;
  cursor: pointer;
  transition: all 0.2s var(--ease-out);
  gap: 0.5rem;
}

.btn:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}

.btn:active {
  transform: scale(0.98);
}

.btn-primary {
  background: var(--c-primary);
  color: #fff;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.25);
}

.btn-primary:hover {
  background: var(--c-primary-hover);
  box-shadow: 0 6px 16px rgba(99, 102, 241, 0.35);
}

.btn-danger {
  background: #fee2e2;
  color: var(--c-error);
}

.btn-danger:hover {
  background: #fecaca;
  color: #b91c1c;
}

.btn-ghost {
  background: transparent;
  border: 1px solid rgba(15, 23, 42, 0.1);
  color: var(--c-text);
}

.btn-ghost:hover {
  background: var(--c-surface);
  border-color: var(--c-text-muted);
}

.link-button {
  border: none;
  background: none;
  color: var(--c-primary);
  cursor: pointer;
  font-size: 0.85rem;
  padding: 0;
  text-decoration: underline;
  text-underline-offset: 4px;
}

.link-button:hover {
  color: var(--c-primary-hover);
}

/* ------------------------------------------------------------------
 * FORMS & INPUTS
 * ------------------------------------------------------------------ */

.controls-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 1.5rem;
}

.control-group {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.control-group label,
.field label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 700;
  color: var(--c-text-muted);
}

select, input[type="text"], input[type="number"], textarea {
  width: 100%;
  border-radius: var(--radius);
  border: 1px solid var(--c-border);
  padding: 0.75rem 1rem;
  font-family: var(--font-base);
  font-size: 0.95rem;
  background: var(--c-surface-soft);
  color: var(--c-text);
  transition: all 0.2s ease;
}

select:hover, input:hover, textarea:hover {
  border-color: #cbd5e1;
}

select:focus, input:focus, textarea:focus {
  outline: none;
  border-color: var(--c-primary);
  background: var(--c-surface);
  box-shadow: 0 0 0 3px var(--c-primary-alpha);
}

.helper-text {
  font-size: 0.8rem;
  color: var(--c-text-muted);
  margin: 0;
  line-height: 1.4;
}

.file-input-wrapper {
  border: 2px dashed rgba(15, 23, 42, 0.2);
  border-radius: var(--radius);
  padding: 3rem 2rem;
  text-align: center;
  background: rgba(248, 250, 252, 0.5);
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
  overflow: hidden;
}

.file-input-wrapper:hover {
  border-color: var(--c-primary);
  background: var(--c-primary-alpha);
  color: var(--c-primary);
}

/* Toggle Switch */
.toggle-switch {
  display: inline-flex;
  align-items: center;
  gap: 1rem;
  cursor: pointer;
}

.toggle-switch input {
  display: none;
}

.toggle-switch__track {
  width: 44px;
  height: 24px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.15);
  position: relative;
  transition: background 0.3s var(--ease-standard);
}

.toggle-switch__thumb {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: transform 0.3s var(--ease-standard);
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.toggle-switch input:checked + .toggle-switch__track {
  background: var(--c-primary);
}

.toggle-switch input:checked + .toggle-switch__track .toggle-switch__thumb {
  transform: translateX(20px);
}

/* ------------------------------------------------------------------
 * REAL-TIME LAYOUT & PANELS
 * ------------------------------------------------------------------ */

.realtime-grid {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 2rem;
  align-items: start;
}

.control-column {
  position: sticky;
  top: calc(var(--header-height) + 1.5rem);
  z-index: var(--z-sticky);
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.panel-card {
  border-radius: var(--radius);
  background: var(--c-surface);
  border: 1px solid rgba(15, 23, 42, 0.08);
  box-shadow: var(--shadow-card);
  overflow: hidden;
  transition: border-color 0.2s ease;
}

.panel-card[data-state='closed'] {
  border-color: rgba(15, 23, 42, 0.04);
}

.panel-card__header {
  width: 100%;
  padding: 1rem 1.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: transparent;
  border: none;
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--c-text);
  cursor: pointer;
  transition: background 0.2s ease;
}

.panel-card__header:hover {
  background: var(--c-surface-soft);
}

.panel-card__chevron {
  font-size: 0.75rem;
  color: var(--c-text-muted);
  transition: transform 0.3s var(--ease-standard);
}

.panel-card[data-state='open'] .panel-card__chevron {
  transform: rotate(180deg);
  color: var(--c-primary);
}

.panel-card__body {
  padding: 0 1.25rem 1.25rem;
  display: grid;
  gap: 1rem;
  animation: slideDown 0.3s var(--ease-out);
}

/* ------------------------------------------------------------------
 * TRANSCRIPT & VISUALIZATION
 * ------------------------------------------------------------------ */

.transcript-panel {
  background: var(--c-surface);
  border-radius: var(--radius-lg);
  border: 1px solid rgba(15, 23, 42, 0.06);
  box-shadow: var(--shadow-card);
  display: flex;
  flex-direction: column;
  height: calc(100vh - 160px);
  min-height: 500px;
  position: relative;
  overflow: hidden;
}

.transcript-header {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--c-surface-soft);
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(255,255,255,0.95);
  z-index: 10;
}

.transcript-body {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  align-items: stretch;
}

.transcript-empty {
  text-align: center;
  color: var(--c-text-muted);
  font-size: 0.95rem;
  margin-top: 4rem;
}

/* Source Selection Pills */
.source-toggle {
  display: grid;
  grid-template-columns: 1fr 1fr;
  background: var(--c-surface-soft);
  border-radius: var(--radius);
  padding: 4px;
  border: 1px solid rgba(15, 23, 42, 0.06);
}

.source-pill {
  border: none;
  background: transparent;
  padding: 0.6rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--c-text-muted);
  border-radius: calc(var(--radius) * 0.8);
  cursor: pointer;
  transition: all 0.2s ease;
}

.source-pill.active {
  background: var(--c-surface);
  color: var(--c-primary);
  box-shadow: var(--shadow-sm);
}

/* Microphone Status & Animation */
.mic-status {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
  border-radius: var(--radius);
  border: 1px dashed rgba(99, 102, 241, 0.4);
  background: rgba(99, 102, 241, 0.03);
  transition: all 0.3s ease;
}

.mic-status.active {
  border-style: solid;
  border-color: var(--c-primary);
  background: #fff;
  box-shadow: var(--shadow-glow);
}

.mic-ring {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  border: 2px solid var(--c-primary-soft);
  display: grid;
  place-items: center;
  position: relative;
  color: var(--c-primary);
}

.mic-status.active .mic-ring::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 2px solid var(--c-primary);
  opacity: 0;
  animation: ripple 1.5s infinite;
}

.mic-meter {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 20px;
}

.mic-meter span {
  width: 4px;
  background: var(--c-text-subtle);
  border-radius: 2px;
  height: 20%;
  transition: height 0.1s ease;
}

.mic-status.active .mic-meter span {
  background: var(--c-primary);
  animation: eq-bounce 0.8s infinite ease-in-out;
}

.mic-meter span:nth-child(1) { animation-delay: 0s; }
.mic-meter span:nth-child(2) { animation-delay: 0.1s; }
.mic-meter span:nth-child(3) { animation-delay: 0.2s; }

/* Message Bubbles */
.msg-bubble {
  width: 100%;
  max-width: 100%;
  padding: 1rem 1.25rem;
  border-radius: var(--radius);
  border-top-left-radius: 2px;
  background: var(--c-surface-soft);
  position: relative;
  animation: bubbleEnter 0.4s var(--ease-out);
  transform-origin: top left;
}

.msg-bubble.final {
  background: var(--c-surface);
  border: 1px solid rgba(15, 23, 42, 0.06);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.04);
}

.msg-bubble.interim {
  background: transparent;
  border: 1px dashed var(--c-border);
  opacity: 0.85;
}

.msg-bubble .bubble-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
  font-size: 0.75rem;
  color: var(--c-text-muted);
  gap: 0.5rem;
  flex-wrap: wrap;
}

.bubble-latency {
  font-family: var(--font-mono);
  color: var(--c-primary);
  background: var(--c-primary-soft);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 500;
}

.bubble-badge {
  padding: 0.2rem 0.45rem;
  border-radius: 999px;
  font-size: 0.7rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  border: 1px solid currentColor;
}

.bubble-badge.degraded {
  color: #9a3412;
  background: #fff7ed;
  border-color: rgba(234, 88, 12, 0.4);
}

.msg-bubble .bubble-text {
  margin: 0;
  font-size: 1rem;
  line-height: 1.6;
  color: var(--c-text);
  white-space: pre-wrap;
  word-break: break-word;
}

.msg-bubble.interim .bubble-text::after {
  content: '…';
  display: inline-block;
  color: var(--c-primary);
  margin-left: 4px;
  vertical-align: baseline;
  opacity: 0.6;
}

.msg-provider {
  display: inline-flex;
  padding: 0.15rem 0.6rem;
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: var(--c-surface-deep);
  color: var(--c-text-muted);
  border-radius: 99px;
}

/* ------------------------------------------------------------------
 * DATA VISUALIZATION & CHARTS
 * ------------------------------------------------------------------ */

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem;
}

.stat-card {
  background: var(--c-surface);
  padding: 1.5rem;
  border-radius: var(--radius);
  border: 1px solid rgba(15, 23, 42, 0.06);
  box-shadow: var(--shadow-sm);
}

.stat-card__value {
  font-size: 1.8rem;
  font-weight: 800;
  font-family: var(--font-mono);
  color: var(--c-text);
  margin: 0 0 0.25rem 0;
  letter-spacing: -0.03em;
}

.stat-card__label {
  font-size: 0.8rem;
  color: var(--c-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 0;
}

.chart-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 1.5rem;
}

/* Quantile Chart Styles */
.quantile-card,
.latency-chart-wrapper {
  background: var(--c-surface);
  border-radius: var(--radius);
  padding: 1.5rem;
  border: 1px solid rgba(15, 23, 42, 0.06);
  box-shadow: var(--shadow-card);
}

.quantile-row {
  display: grid;
  grid-template-columns: 100px 1fr 60px;
  gap: 1rem;
  align-items: center;
  margin-bottom: 0.75rem;
}

.quantile-row__label {
  font-size: 0.85rem;
  font-weight: 600;
}

.quantile-row__bars {
  height: 8px;
  background: var(--c-surface-deep);
  border-radius: 4px;
  position: relative;
  overflow: hidden;
}

.bar {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: 4px;
}

.bar-p95 {
  background: rgba(99, 102, 241, 0.2);
}

.bar-p50 {
  background: var(--c-primary);
  height: 60%;
  top: 20%;
}

.quantile-row__values {
  font-family: var(--font-mono);
  font-size: 0.8rem;
  text-align: right;
  color: var(--c-text-muted);
}

/* SVG Chart Styles */
.latency-chart {
  background: var(--c-surface);
  border-radius: var(--radius);
  width: 100%;
}

.latency-line {
  fill: none;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.latency-line.p50 { stroke: var(--c-primary); }
.latency-line.p95 { stroke: rgba(99, 102, 241, 0.3); }

.latency-dot {
  stroke: var(--c-surface);
  stroke-width: 2px;
}
.latency-dot.p50 { fill: var(--c-primary); }
.latency-dot.p95 { fill: rgba(99, 102, 241, 0.5); }

/* Table Styles */
.table-wrapper {
  overflow-x: auto;
  border-radius: var(--radius);
  border: 1px solid var(--c-border);
}

/* Batch transcript preview */
.transcript-card__header {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.transcript-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-top: 0.75rem;
}

.transcript-entry {
  border: 1px solid var(--c-border);
  border-radius: var(--radius);
  padding: 0.5rem 0.75rem;
  background: var(--c-surface);
}

.transcript-entry summary {
  list-style: none;
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  align-items: flex-start;
  cursor: pointer;
  padding: 0;
}

.transcript-entry summary::-webkit-details-marker {
  display: none;
}

.transcript-entry summary::marker {
  content: '';
}

.transcript-entry__meta {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.transcript-entry__path {
  font-family: var(--font-mono);
  font-weight: 600;
}

.transcript-entry__metrics {
  display: flex;
  gap: 0.75rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--c-text-muted);
}

.transcript-entry__text {
  margin-top: 0.75rem;
  padding: 0.75rem;
  border-radius: var(--radius);
  background: var(--c-surface-soft);
  font-size: 0.95rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

th, td {
  padding: 1rem;
  text-align: left;
}

thead th {
  background: var(--c-surface-soft);
  color: var(--c-text-muted);
  font-weight: 600;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

tbody tr {
  border-bottom: 1px solid var(--c-border);
}

tbody tr:last-child {
  border-bottom: none;
}

.data-table td {
  background: var(--c-surface);
}

.realtime-log-card__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  flex-wrap: wrap;
}

.realtime-log-card__actions {
  display: flex;
  align-items: center;
}

.log-type {
  font-size: 0.75rem;
  font-weight: 700;
  padding: 0.15rem 0.6rem;
  border-radius: var(--radius-pill);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-transform: none;
  letter-spacing: 0.02em;
}

.log-type--session {
  background: var(--c-primary-soft);
  color: var(--c-primary);
}

.log-type--transcript {
  background: rgba(59, 130, 246, 0.15);
  color: #1d4ed8;
}

.log-type--error {
  background: rgba(239, 68, 68, 0.15);
  color: #b91c1c;
}

.log-type--session_end {
  background: rgba(16, 185, 129, 0.15);
  color: #047857;
}

.log-record-table td {
  vertical-align: top;
}

.log-record-table .log-latency {
  font-family: var(--font-mono);
}

.log-metadata {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.35rem;
  font-size: 0.8rem;
  color: var(--c-text-muted);
}

.log-metadata__item {
  display: flex;
  gap: 0.25rem;
  align-items: baseline;
}

.log-metadata__label {
  font-weight: 600;
  color: var(--c-text);
}

.log-words-detail {
  margin-top: 0.5rem;
  font-size: 0.8rem;
}

.log-words-detail summary {
  cursor: pointer;
  font-weight: 600;
  margin-bottom: 0.25rem;
}

.log-words-table-wrapper {
  overflow-x: auto;
  border-radius: var(--radius);
  border: 1px solid var(--c-border);
}

.log-words-table {
  width: 100%;
  border-collapse: collapse;
}

.log-words-table th,
.log-words-table td {
  padding: 0.35rem 0.5rem;
  text-align: left;
  border-bottom: 1px solid var(--c-border);
}

.log-words-table thead th {
  text-transform: uppercase;
  font-size: 0.7rem;
  color: var(--c-text-muted);
}

.log-words-table tbody tr:last-child td {
  border-bottom: none;
}

/* Progress Bars */
.progress-track {
  width: 100%;
  height: 8px;
  background: var(--c-surface-deep);
  border-radius: 999px;
  overflow: hidden;
  margin-top: 0.75rem;
}

.progress-fill {
  height: 100%;
  background: var(--c-success);
  transition: width 0.4s ease;
}

/* ------------------------------------------------------------------
 * FLOATING FOOTER ACTION
 * ------------------------------------------------------------------ */

.floating-action {
  position: fixed;
  bottom: 2rem;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  pointer-events: none; /* Let clicks pass through */
  z-index: var(--z-sticky);
  padding: 0 1rem;
}

.floating-action__panel {
  pointer-events: auto; /* Re-enable clicks */
  background: #1e1b4b; /* Dark Indigo */
  color: #fff;
  border-radius: var(--radius-pill);
  padding: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  box-shadow: 0 20px 40px -10px rgba(30, 27, 75, 0.5);
  transform: translateY(0);
  transition: transform 0.3s var(--ease-out);
}

.floating-action__panel:hover {
  transform: translateY(-4px) scale(1.02);
}

.floating-action__btn {
  border: none;
  background: #fff;
  color: var(--c-primary);
  border-radius: var(--radius-pill);
  height: 3rem;
  padding: 0 1.5rem;
  font-weight: 700;
  font-size: 0.95rem;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  cursor: pointer;
  transition: filter 0.2s ease, transform 0.2s ease;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}

.floating-action__btn:hover:not(:disabled) {
  filter: brightness(1.05);
  transform: scale(1.03);
}

.floating-action__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  filter: grayscale(1);
}

.floating-action__meter {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 24px;
  padding-right: 0.5rem;
}

.floating-action__meter span {
  width: 4px;
  background: rgba(255, 255, 255, 0.4);
  border-radius: 99px;
  height: 12px;
  transition: height 0.1s ease;
}

.floating-action__meter.active span {
  background: #fff;
  animation: meterPulse 1s infinite ease-in-out;
}

.floating-action__meter span:nth-child(2) { animation-delay: 0.1s; height: 16px; }
.floating-action__meter span:nth-child(3) { animation-delay: 0.2s; height: 20px; }

/* ------------------------------------------------------------------
 * KEYFRAMES
 * ------------------------------------------------------------------ */

@keyframes bubbleEnter {
  from { opacity: 0; transform: translateY(12px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes slideDown {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes floatIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes ripple {
  0% { transform: scale(1); opacity: 0.4; }
  100% { transform: scale(1.6); opacity: 0; }
}

@keyframes blink {
  50% { opacity: 0; }
}

@keyframes eq-bounce {
  0%, 100% { height: 20%; }
  50% { height: 80%; }
}

@keyframes meterPulse {
  0%, 100% { transform: scaleY(0.6); }
  50% { transform: scaleY(1.2); }
}

/* ------------------------------------------------------------------
 * RESPONSIVE & ACCESSIBILITY
 * ------------------------------------------------------------------ */

@media (max-width: 960px) {
  .realtime-grid {
    grid-template-columns: 1fr;
    gap: 1.5rem;
  }

  .control-column {
    position: relative;
    top: 0;
    z-index: var(--z-base);
    order: -1; /* Controls on top */
  }

  .transcript-panel {
    height: 600px;
  }
}

@media (max-width: 640px) {
  .app-shell {
    width: 100%;
    padding: 1rem 1rem 7rem;
  }

  .glass-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 1rem;
    padding: 1rem;
  }

  .tabs {
    overflow-x: auto;
    display: flex;
    scrollbar-width: none; /* Hide scrollbar Firefox */
  }
  .tabs::-webkit-scrollbar { display: none; } /* Hide scrollbar Webkit */

  .tab-button {
    flex: 0 0 auto;
    min-width: 100px;
  }

  .msg-bubble {
    max-width: 100%;
  }

  .floating-action__panel {
    width: 100%;
    justify-content: space-between;
  }

  .floating-action__btn {
    flex-grow: 1;
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }

  .mic-status.active .mic-ring::after {
    display: none;
  }
}
`;
