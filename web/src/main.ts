import { createEngine, type MjswanEngine } from 'mjswan';
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
const LABELS = ['肩屈伸', '肩外展/内收', '前臂前后', '手部开闭'] as const;
const TARGETS = [
  [-0.45, 0.22, 0.72],
  [-0.30, -0.35, 0.82],
  [-0.15, 0.38, 0.55],
] as const;
const TARGET_RADIUS = 0.065;
const DWELL_SECONDS = 0.75;
const PHYSICS_DT = 0.002;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">MUJOCO · MJSWAN · 4-DOF</p>
        <h1>肩义手虚拟控制实验</h1>
      </div>
      <div class="status-cluster">
        <span id="engine-status" class="status loading">正在加载模型</span>
        <span id="mode-badge" class="mode-badge">J1 · 肩部</span>
      </div>
    </header>

    <section class="workspace">
      <div class="viewer-card">
        <div id="viewer" aria-label="MuJoCo 3D simulation"></div>
        <div class="viewer-hint">拖动旋转 · 滚轮缩放 · 红球为任务目标</div>
        <div id="load-error" class="load-error hidden"></div>
      </div>

      <aside class="panel">
        <section class="panel-section experiment">
          <div class="section-heading">
            <div>
              <span class="section-kicker">TASK</span>
              <h2>目标到达实验</h2>
            </div>
            <span id="trial-state" class="trial-state">未开始</span>
          </div>
          <div class="metric-grid">
            <div><span>目标</span><strong id="target-index">1 / 3</strong></div>
            <div><span>末端误差</span><strong id="distance">—</strong></div>
            <div><span>停留</span><strong id="dwell">0.00 s</strong></div>
            <div><span>切换次数</span><strong id="switch-count">0</strong></div>
          </div>
          <div class="button-row">
            <button id="start-trial" class="primary">开始实验</button>
            <button id="download-csv" disabled>下载 CSV</button>
          </div>
        </section>

        <section class="panel-section controls">
          <div class="section-heading">
            <div>
              <span class="section-kicker">CONTROL</span>
              <h2 id="control-title">J1 · 肩屈伸 / 肩外展内收</h2>
            </div>
            <button id="toggle-mode" class="key-button">Space</button>
          </div>

          <div class="joystick-grid" aria-label="触屏方向控制">
            <button class="joy up" data-key="w"><kbd>W</kbd><span id="label-w">肩屈曲</span></button>
            <button class="joy left" data-key="a"><kbd>A</kbd><span id="label-a">肩外展</span></button>
            <div class="stick-center"><span>J1</span></div>
            <button class="joy right" data-key="d"><kbd>D</kbd><span id="label-d">肩内收</span></button>
            <button class="joy down" data-key="s"><kbd>S</kbd><span id="label-s">肩伸展</span></button>
          </div>

          <div class="button-row utility-row">
            <button id="reset"><kbd>R</kbd> 复位</button>
            <button id="frame-camera">重新取景</button>
          </div>
        </section>

        <section class="panel-section telemetry">
          <div class="section-heading">
            <div>
              <span class="section-kicker">TELEMETRY</span>
              <h2>实时关节状态</h2>
            </div>
          </div>
          <div id="joint-list" class="joint-list"></div>
        </section>

        <p class="disclaimer">等效运动学原型：几何、轴线、限位和动力学参数尚未由真实 Fusion 机构验证。</p>
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
const stickCenter = document.querySelector<HTMLDivElement>('.stick-center span')!;
const loadError = byId<HTMLDivElement>('load-error');
const jointList = byId<HTMLDivElement>('joint-list');
const trialState = byId<HTMLSpanElement>('trial-state');
const targetIndexElement = byId<HTMLSpanElement>('target-index');
const distanceElement = byId<HTMLSpanElement>('distance');
const dwellElement = byId<HTMLSpanElement>('dwell');
const switchCountElement = byId<HTMLSpanElement>('switch-count');
const startTrialButton = byId<HTMLButtonElement>('start-trial');
const downloadButton = byId<HTMLButtonElement>('download-csv');

jointList.innerHTML = LABELS.map((label, index) => `
  <div class="joint-row">
    <div><span>${label}</span><strong id="joint-value-${index}">—</strong></div>
    <div class="track"><i id="joint-bar-${index}"></i></div>
  </div>
`).join('');

let engine: InternalEngine | null = null;
let data: MjDataAccess | null = null;
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

function setMode(nextMode: 0 | 1, countSwitch = true): void {
  if (nextMode === mode) return;
  mode = nextMode;
  if (countSwitch && trialActive) modeSwitches += 1;
  clearInput();
  const j1 = mode === 0;
  modeBadge.textContent = j1 ? 'J1 · 肩部' : 'J2 · 前臂 / 手';
  controlTitle.textContent = j1 ? 'J1 · 肩屈伸 / 肩外展内收' : 'J2 · 前臂前后 / 手部开闭';
  stickCenter.textContent = j1 ? 'J1' : 'J2';
  byId('label-w').textContent = j1 ? '肩屈曲' : '前臂前';
  byId('label-s').textContent = j1 ? '肩伸展' : '前臂后';
  byId('label-a').textContent = j1 ? '肩外展' : '手打开';
  byId('label-d').textContent = j1 ? '肩内收' : '手闭合';
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
  targetIndexElement.textContent = trialComplete ? '完成' : `${targetIndex + 1} / ${TARGETS.length}`;
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
        trialState.textContent = '已完成';
        trialState.classList.add('complete');
        startTrialButton.textContent = '重新开始';
      } else {
        targetIndex += 1;
      }
    }
  } else {
    dwell = 0;
  }
}

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
  trialState.textContent = '进行中';
  trialState.classList.remove('complete');
  startTrialButton.textContent = '重新开始';
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

async function boot(): Promise<void> {
  try {
    const publicBase = import.meta.env.BASE_URL;
    const modelResponse = await fetch(`${publicBase}model/shoulder_prosthesis_simplified.mjz`);
    if (!modelResponse.ok) throw new Error(`模型下载失败：HTTP ${modelResponse.status}`);

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
    if (!data) throw new Error('Mjswan 已加载，但无法取得 MuJoCo 状态。');
    for (let index = 0; index < engine.runtime.mjModel.nsite; index += 1) {
      if (engine.runtime.mjModel.site(index).name.endsWith('end_effector')) {
        endEffectorSiteId = index;
        break;
      }
    }
    if (endEffectorSiteId < 0) throw new Error('模型中找不到 end_effector site。');
    resetSimulation();
    // Deliberately keep Mjswan's policy loop paused; update() owns physics stepping.
    statusElement.textContent = '仿真已就绪';
    statusElement.className = 'status ready';
    startTrialButton.disabled = false;
    updateTelemetry();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    statusElement.textContent = '加载失败';
    statusElement.className = 'status error';
    loadError.textContent = message;
    loadError.classList.remove('hidden');
    console.error(error);
  }
}

startTrialButton.disabled = true;
requestAnimationFrame(update);
void boot();
