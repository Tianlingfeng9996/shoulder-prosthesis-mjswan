import { createEngine, type MjswanEngine } from 'mjswan';
import { COPY, isLocale, loadLocale, saveLocale, type Locale } from './i18n';
import './style.css';

type NumericArray = { [index: number]: number; length: number; fill(value: number): void };
type MjDataAccess = {
  ctrl: NumericArray;
  qpos: NumericArray;
  qvel: NumericArray;
  site_xpos: NumericArray;
  time: number;
};
type MjModelAccess = {
  nsite: number;
  site(index: number): { name: string };
};
type RuntimeAccess = {
  mjData: MjDataAccess | null;
  mjModel: MjModelAccess;
  mujoco: {
    mj_forward(model: MjModelAccess, data: MjDataAccess): void;
    mj_step(model: MjModelAccess, data: MjDataAccess): void;
  };
  updateCachedState(): void;
  stop(): Promise<void>;
};
type InternalEngine = MjswanEngine & { runtime: RuntimeAccess };

const RAD = Math.PI / 180;
const HOME = [10 * RAD, 10 * RAD, 45 * RAD, 0.015] as const;
const LOWER = [-30 * RAD, -10 * RAD, -20 * RAD, 0] as const;
const UPPER = [100 * RAD, 90 * RAD, 110 * RAD, 0.035] as const;
const SPEED = [35 * RAD, 35 * RAD, 45 * RAD, 0.02] as const;
const TARGETS = [
  [-0.45, 0.22, 0.72],
  [-0.30, -0.35, 0.82],
  [-0.15, 0.38, 0.55],
] as const;
const TARGET_RADIUS = 0.065;
const DWELL_SECONDS = 0.75;
const PHYSICS_DT = 0.002;

type LoadFailure =
  | { code: 'http'; status: number }
  | { code: 'no-data' }
  | { code: 'no-site' }
  | { code: 'unknown'; message: string };

class LoadError extends Error {
  constructor(readonly failure: LoadFailure) {
    super(failure.code);
    this.name = 'LoadError';
  }
}

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

let locale: Locale = loadLocale();

const copy = (): (typeof COPY)[Locale] => COPY[locale];

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">MUJOCO · MJSWAN · 4-DOF</p>
        <h1 id="page-title"></h1>
      </div>
      <div class="status-cluster">
        <div class="lang-toggle" id="lang-toggle" role="group">
          <button type="button" id="lang-ja" data-locale="ja">日本語</button>
          <button type="button" id="lang-zh" data-locale="zh">中文</button>
        </div>
        <span id="engine-status" class="status loading"></span>
        <span id="mode-badge" class="mode-badge"></span>
      </div>
    </header>

    <section class="workspace">
      <div class="viewer-card">
        <div id="viewer" aria-label="MuJoCo 3D simulation"></div>
        <div id="viewer-hint" class="viewer-hint"></div>
        <div id="load-error" class="load-error hidden"></div>
      </div>

      <aside class="panel">
        <section class="panel-section experiment">
          <div class="section-heading">
            <div>
              <span class="section-kicker">TASK</span>
              <h2 id="task-title"></h2>
            </div>
            <span id="trial-state" class="trial-state"></span>
          </div>
          <div class="metric-grid">
            <div><span id="metric-target-label"></span><strong id="target-index">1 / 3</strong></div>
            <div><span id="metric-error-label"></span><strong id="distance">—</strong></div>
            <div><span id="metric-dwell-label"></span><strong id="dwell">0.00 s</strong></div>
            <div><span id="metric-switches-label"></span><strong id="switch-count">0</strong></div>
          </div>
          <div class="button-row">
            <button id="start-trial" class="primary"></button>
            <button id="download-csv" disabled></button>
          </div>
        </section>

        <section class="panel-section controls">
          <div class="section-heading">
            <div>
              <span class="section-kicker">CONTROL</span>
              <h2 id="control-title"></h2>
            </div>
            <button id="toggle-mode" class="key-button">Space</button>
          </div>

          <div class="joystick-grid" id="joystick">
            <button class="joy up" data-key="w"><kbd>W</kbd><span id="label-w"></span></button>
            <button class="joy left" data-key="a"><kbd>A</kbd><span id="label-a"></span></button>
            <div class="stick-center"><span id="stick-label">J1</span></div>
            <button class="joy right" data-key="d"><kbd>D</kbd><span id="label-d"></span></button>
            <button class="joy down" data-key="s"><kbd>S</kbd><span id="label-s"></span></button>
          </div>

          <div class="button-row utility-row">
            <button id="reset"><kbd>R</kbd> <span id="reset-label"></span></button>
            <button id="frame-camera"></button>
          </div>
        </section>

        <section class="panel-section telemetry">
          <div class="section-heading">
            <div>
              <span class="section-kicker">TELEMETRY</span>
              <h2 id="telemetry-title"></h2>
            </div>
          </div>
          <div id="joint-list" class="joint-list">
            ${[0, 1, 2, 3].map((index) => `
              <div class="joint-row">
                <div><span id="joint-label-${index}"></span><strong id="joint-value-${index}">—</strong></div>
                <div class="track"><i id="joint-bar-${index}"></i></div>
              </div>
            `).join('')}
          </div>
        </section>

        <p id="disclaimer" class="disclaimer"></p>
      </aside>
    </section>
  </main>
`;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
};

const viewer = byId<HTMLDivElement>('viewer');
const statusElement = byId<HTMLSpanElement>('engine-status');
const modeBadge = byId<HTMLSpanElement>('mode-badge');
const controlTitle = byId<HTMLHeadingElement>('control-title');
const stickCenter = byId<HTMLSpanElement>('stick-label');
const loadError = byId<HTMLDivElement>('load-error');
const trialState = byId<HTMLSpanElement>('trial-state');
const targetIndexElement = byId<HTMLSpanElement>('target-index');
const distanceElement = byId<HTMLSpanElement>('distance');
const dwellElement = byId<HTMLSpanElement>('dwell');
const switchCountElement = byId<HTMLSpanElement>('switch-count');
const startTrialButton = byId<HTMLButtonElement>('start-trial');
const downloadButton = byId<HTMLButtonElement>('download-csv');

let engine: InternalEngine | null = null;
let data: MjDataAccess | null = null;
let enginePhase: 'loading' | 'ready' | 'error' = 'loading';
let loadFailure: LoadFailure | null = null;
let mode: 0 | 1 = 0;
let targets = [...HOME];
let lastFrame = performance.now();
let physicsAccumulator = 0;
let lastUiUpdate = 0;
let lastLogTime = -Infinity;
let pressed = new Set<string>();
let trialActive = false;
let trialComplete = false;
let targetIndex = 0;
let dwell = 0;
let modeSwitches = 0;
let trialStartSimTime = 0;
let logRows: string[][] = [];
let endEffectorSiteId = -1;

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

function axis(positive: string, negative: string): number {
  return Number(pressed.has(positive)) - Number(pressed.has(negative));
}

function clearInput(): void {
  pressed.clear();
  document.querySelectorAll('.joy.active').forEach((button) => button.classList.remove('active'));
}

function applyTargets(): void {
  if (!data) return;
  for (let index = 0; index < 4; index += 1) data.ctrl[index] = targets[index];
}

function resetSimulation(): void {
  if (!engine || !data) return;
  clearInput();
  engine.reset();
  targets = [...HOME];
  for (let index = 0; index < data.qvel.length; index += 1) data.qvel[index] = 0;
  data.qpos[0] = HOME[0];
  data.qpos[1] = HOME[1];
  data.qpos[2] = HOME[2];
  data.qpos[3] = HOME[3];
  data.qpos[4] = HOME[3];
  applyTargets();
  engine.runtime.mujoco.mj_forward(engine.runtime.mjModel, data);
  engine.runtime.updateCachedState();
  physicsAccumulator = 0;
}

function renderControlLabels(): void {
  const text = copy();
  const j1 = mode === 0;
  modeBadge.textContent = j1 ? text.modeJ1Badge : text.modeJ2Badge;
  controlTitle.textContent = j1 ? text.modeJ1Title : text.modeJ2Title;
  stickCenter.textContent = j1 ? 'J1' : 'J2';
  byId('label-w').textContent = j1 ? text.labelFlexion : text.labelForearmForward;
  byId('label-s').textContent = j1 ? text.labelExtension : text.labelForearmBack;
  byId('label-a').textContent = j1 ? text.labelAbduction : text.labelHandOpen;
  byId('label-d').textContent = j1 ? text.labelAdduction : text.labelHandClose;
}

function renderTrialChrome(): void {
  const text = copy();
  const phase = trialComplete ? 'complete' : trialActive ? 'running' : 'idle';
  trialState.textContent = phase === 'complete' ? text.trialComplete : phase === 'running' ? text.trialRunning : text.trialIdle;
  trialState.classList.toggle('complete', phase === 'complete');
  startTrialButton.textContent = phase === 'idle' ? text.startTrial : text.restartTrial;
  if (trialComplete) targetIndexElement.textContent = text.targetDone;
}

function failureText(failure: LoadFailure): string {
  const text = copy();
  switch (failure.code) {
    case 'http':
      return text.modelDownloadFailed(failure.status);
    case 'no-data':
      return text.noMjData;
    case 'no-site':
      return text.noEndEffector;
    case 'unknown':
      return failure.message;
  }
}

function renderStatus(): void {
  const text = copy();
  if (enginePhase === 'ready') {
    statusElement.textContent = text.ready;
    statusElement.className = 'status ready';
    return;
  }
  if (enginePhase === 'error') {
    statusElement.textContent = text.loadFailed;
    statusElement.className = 'status error';
    if (loadFailure) {
      loadError.textContent = failureText(loadFailure);
      loadError.classList.remove('hidden');
    }
    return;
  }
  statusElement.textContent = text.loading;
  statusElement.className = 'status loading';
}

function applyCopy(): void {
  const text = copy();
  document.documentElement.lang = text.htmlLang;
  document.title = text.title;
  document.querySelector('meta[name="description"]')?.setAttribute('content', text.description);
  byId('page-title').textContent = text.title;
  byId('viewer-hint').textContent = text.viewerHint;
  byId('task-title').textContent = text.taskTitle;
  byId('metric-target-label').textContent = text.metricTarget;
  byId('metric-error-label').textContent = text.metricError;
  byId('metric-dwell-label').textContent = text.metricDwell;
  byId('metric-switches-label').textContent = text.metricSwitches;
  downloadButton.textContent = text.downloadCsv;
  byId('reset-label').textContent = text.reset;
  byId('frame-camera').textContent = text.frameCamera;
  byId('telemetry-title').textContent = text.telemetryTitle;
  byId('disclaimer').textContent = text.disclaimer;
  byId('joystick').setAttribute('aria-label', text.joyAria);
  byId('lang-toggle').setAttribute('aria-label', text.langAria);
  text.joints.forEach((label, index) => {
    byId(`joint-label-${index}`).textContent = label;
  });
  byId('lang-ja').setAttribute('aria-pressed', locale === 'ja' ? 'true' : 'false');
  byId('lang-zh').setAttribute('aria-pressed', locale === 'zh' ? 'true' : 'false');
  renderControlLabels();
  renderTrialChrome();
  renderStatus();
  if (data) updateTelemetry();
}

function setLocale(next: Locale): void {
  if (next === locale) return;
  locale = next;
  saveLocale(locale);
  applyCopy();
}

function setMode(nextMode: 0 | 1, countSwitch = true): void {
  if (nextMode === mode) return;
  mode = nextMode;
  if (countSwitch && trialActive) modeSwitches += 1;
  clearInput();
  renderControlLabels();
  switchCountElement.textContent = String(modeSwitches);
}

function toggleMode(): void {
  setMode(mode === 0 ? 1 : 0);
}

function formatJoint(index: number, value: number): string {
  return index < 3 ? `${(value / RAD).toFixed(1)}°` : `${(value * 1000).toFixed(1)} mm`;
}

function endEffectorPosition(): [number, number, number] {
  if (!data || endEffectorSiteId < 0) return [0, 0, 0];
  const offset = endEffectorSiteId * 3;
  return [data.site_xpos[offset], data.site_xpos[offset + 1], data.site_xpos[offset + 2]];
}

function currentDistance(): number {
  const ee = endEffectorPosition();
  const target = TARGETS[targetIndex];
  return Math.hypot(ee[0] - target[0], ee[1] - target[1], ee[2] - target[2]);
}

function updateTelemetry(): void {
  if (!data) return;
  for (let index = 0; index < 4; index += 1) {
    const value = data.qpos[index];
    byId(`joint-value-${index}`).textContent = formatJoint(index, value);
    const percent = 100 * (value - LOWER[index]) / (UPPER[index] - LOWER[index]);
    (byId(`joint-bar-${index}`) as HTMLElement).style.width = `${clamp(percent, 0, 100)}%`;
  }
  const distance = currentDistance();
  distanceElement.textContent = `${(distance * 1000).toFixed(0)} mm`;
  distanceElement.classList.toggle('success-text', distance <= TARGET_RADIUS);
  dwellElement.textContent = `${dwell.toFixed(2)} s`;
  targetIndexElement.textContent = trialComplete ? copy().targetDone : `${targetIndex + 1} / ${TARGETS.length}`;
  switchCountElement.textContent = String(modeSwitches);
}

function updateTask(dt: number): void {
  if (!trialActive || trialComplete) return;
  if (currentDistance() <= TARGET_RADIUS) {
    dwell += dt;
    if (dwell >= DWELL_SECONDS) {
      dwell = 0;
      if (targetIndex + 1 >= TARGETS.length) {
        trialComplete = true;
        trialActive = false;
        renderTrialChrome();
      } else {
        targetIndex += 1;
      }
    }
  } else {
    dwell = 0;
  }
}

// Column headers stay English so exported trials remain machine-readable.
const CSV_HEADER = [
  'sim_time_s', 'trial_time_s', 'mode', 'vertical_input', 'horizontal_input',
  'shoulder_flexion_deg', 'shoulder_abduction_deg', 'forearm_pitch_deg',
  'hand_aperture_left_m', 'target_shoulder_flexion_deg',
  'target_shoulder_abduction_deg', 'target_forearm_pitch_deg',
  'target_hand_aperture_left_m', 'end_effector_x_m', 'end_effector_y_m',
  'end_effector_z_m', 'target_index', 'target_x_m', 'target_y_m', 'target_z_m',
  'target_error_m', 'mode_switches',
];

function logSample(): void {
  if (!data || !trialActive) return;
  if (data.time - lastLogTime < 0.0195) return;
  lastLogTime = data.time;
  const ee = endEffectorPosition();
  const taskTarget = TARGETS[targetIndex];
  logRows.push([
    data.time.toFixed(4),
    (data.time - trialStartSimTime).toFixed(4),
    mode === 0 ? 'J1' : 'J2',
    String(axis('w', 's')),
    String(axis('a', 'd')),
    (data.qpos[0] / RAD).toFixed(5),
    (data.qpos[1] / RAD).toFixed(5),
    (data.qpos[2] / RAD).toFixed(5),
    data.qpos[3].toFixed(6),
    (targets[0] / RAD).toFixed(5),
    (targets[1] / RAD).toFixed(5),
    (targets[2] / RAD).toFixed(5),
    targets[3].toFixed(6),
    ee[0].toFixed(6), ee[1].toFixed(6), ee[2].toFixed(6),
    String(targetIndex + 1),
    taskTarget[0].toFixed(6), taskTarget[1].toFixed(6), taskTarget[2].toFixed(6),
    currentDistance().toFixed(6), String(modeSwitches),
  ]);
  downloadButton.disabled = false;
}

function startTrial(): void {
  if (!data) return;
  resetSimulation();
  setMode(0, false);
  targetIndex = 0;
  dwell = 0;
  modeSwitches = 0;
  trialComplete = false;
  trialActive = true;
  trialStartSimTime = data.time;
  lastLogTime = -Infinity;
  logRows = [];
  renderTrialChrome();
  downloadButton.disabled = true;
  updateTelemetry();
}

function escapeCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function downloadCsv(): void {
  if (logRows.length === 0) return;
  const content = [CSV_HEADER, ...logRows].map((row) => row.map(escapeCsv).join(',')).join('\n');
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  link.href = url;
  link.download = `shoulder_trial_${stamp}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function update(now: number): void {
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  if (data && engine) {
    const vertical = axis('w', 's');
    const horizontal = axis('a', 'd');
    const commands = mode === 0 ? [[0, vertical], [1, horizontal]] : [[2, vertical], [3, horizontal]];
    for (const [index, direction] of commands) {
      targets[index] = clamp(targets[index] + direction * SPEED[index] * dt, LOWER[index], UPPER[index]);
    }
    // Mjswan 0.10.2 clears ctrl inside its policy-oriented run loop when no policy
    // is configured. Keep that loop paused and advance MuJoCo here so keyboard-set
    // position targets remain active. Rendering continues independently in Mjswan.
    physicsAccumulator += dt;
    while (physicsAccumulator >= PHYSICS_DT) {
      applyTargets();
      engine.runtime.mujoco.mj_step(engine.runtime.mjModel, data);
      physicsAccumulator -= PHYSICS_DT;
    }
    engine.runtime.updateCachedState();
    updateTask(dt);
    logSample();
    if (now - lastUiUpdate > 50) {
      updateTelemetry();
      lastUiUpdate = now;
    }
  }
  requestAnimationFrame(update);
}

function setPressed(key: string, active: boolean): void {
  if (!['w', 'a', 's', 'd'].includes(key)) return;
  if (active) pressed.add(key); else pressed.delete(key);
  document.querySelectorAll<HTMLElement>(`[data-key="${key}"]`).forEach((button) => {
    button.classList.toggle('active', active);
  });
}

window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (event.target instanceof HTMLButtonElement && (key === ' ' || key === 'enter')) return;
  if (event.repeat && [' ', 'r'].includes(key)) return;
  if (['w', 'a', 's', 'd', 'r', ' '].includes(key)) event.preventDefault();
  if (['w', 'a', 's', 'd'].includes(key)) setPressed(key, true);
  else if (key === ' ') toggleMode();
  else if (key === 'r') resetSimulation();
});

window.addEventListener('keyup', (event) => setPressed(event.key.toLowerCase(), false));
window.addEventListener('blur', clearInput);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearInput(); });

document.querySelectorAll<HTMLButtonElement>('.joy').forEach((button) => {
  const key = button.dataset.key!;
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    setPressed(key, true);
  });
  const release = () => setPressed(key, false);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
});

byId('toggle-mode').addEventListener('click', toggleMode);
byId('reset').addEventListener('click', resetSimulation);
byId('frame-camera').addEventListener('click', () => engine?.camera.frame());
startTrialButton.addEventListener('click', startTrial);
downloadButton.addEventListener('click', downloadCsv);
document.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach((button) => {
  button.addEventListener('click', () => {
    const next = button.dataset.locale ?? null;
    if (isLocale(next)) setLocale(next);
  });
});

async function boot(): Promise<void> {
  try {
    const publicBase = import.meta.env.BASE_URL;
    const modelResponse = await fetch(`${publicBase}model/shoulder_prosthesis_simplified.mjz`);
    if (!modelResponse.ok) throw new LoadError({ code: 'http', status: modelResponse.status });

    const publicEngine = await createEngine(viewer, { multithreaded: false });
    engine = publicEngine as InternalEngine;
    await engine.loadScene({
      model: await modelResponse.arrayBuffer(),
      viewer: {
        lookat: [0, 0, 0.66],
        distance: 1.7,
        elevation: -18,
        azimuth: 135,
        originType: 'WORLD',
        enableShadows: true,
      },
    });
    engine.pause();
    await engine.runtime.stop();
    data = engine.runtime.mjData;
    if (!data) throw new LoadError({ code: 'no-data' });
    for (let index = 0; index < engine.runtime.mjModel.nsite; index += 1) {
      if (engine.runtime.mjModel.site(index).name.endsWith('end_effector')) {
        endEffectorSiteId = index;
        break;
      }
    }
    if (endEffectorSiteId < 0) throw new LoadError({ code: 'no-site' });
    resetSimulation();
    // Deliberately keep Mjswan's policy loop paused; update() owns physics stepping.
    enginePhase = 'ready';
    renderStatus();
    startTrialButton.disabled = false;
    updateTelemetry();
  } catch (error) {
    enginePhase = 'error';
    loadFailure = error instanceof LoadError
      ? error.failure
      : { code: 'unknown', message: error instanceof Error ? error.message : String(error) };
    renderStatus();
    console.error(error);
  }
}

applyCopy();
startTrialButton.disabled = true;
requestAnimationFrame(update);
void boot();
