import { createEngine, type MjswanEngine } from 'mjswan';
import { COPY, isLocale, loadLocale, saveLocale, type Locale } from './i18n';
import {
  CUBE_COUNT,
  CUBE_NAMES,
  CUBE_SPAWN,
  DEMO_CAMERA,
  GRASP_CLOSE,
  GRASP_RELEASE,
  HAND_BODY,
  LEFT_FINGER_GEOM,
  PAP_CAMERA,
  PAP_HOME,
  PARK_Z,
  RIGHT_FINGER_GEOM,
  STAGE_JOINT,
  ZONE_B_GEOM,
  ZONE_HEIGHT,
  containsPoint,
  emptyLatches,
  formatElapsed,
  handFromWorld,
  holdPoint,
  nearestFingerCube,
  placedCount,
  stepLatches,
  worldFromHand,
  zoneFromBox,
  type AppMode,
  type Latch,
  type Quat,
  type Vec3,
  type Zone,
} from './pap';
import './style.css';

type NumericArray = { [index: number]: number; length: number; fill(value: number): void };
type MjDataAccess = {
  ctrl: NumericArray;
  qpos: NumericArray;
  qvel: NumericArray;
  site_xpos: NumericArray;
  xpos: NumericArray;
  xquat: NumericArray;
  geom_xpos: NumericArray;
  xfrc_applied: NumericArray;
  time: number;
};
type MjModelAccess = {
  nsite: number;
  site(index: number): { name: string };
  body(name: string): { id: number };
  geom(name: string): { id: number; pos: NumericArray; size: NumericArray };
  jnt(name: string): { id: number };
  jnt_qposadr: NumericArray;
  jnt_dofadr: NumericArray;
  opt: { gravity: NumericArray; enableflags: number };
  geom_contype: NumericArray;
  body_mass: NumericArray;
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
          <button type="button" id="lang-en" data-locale="en">English</button>
        </div>
        <span id="engine-status" class="status loading"></span>
        <span id="mode-badge" class="mode-badge"></span>
      </div>
    </header>

    <section class="workspace">
      <div class="viewer-card">
        <div id="viewer" aria-label="MuJoCo 3D simulation"></div>
        <div id="pap-banner" class="pap-banner hidden">
          <strong id="pap-banner-title"></strong>
          <p id="pap-banner-detail"></p>
          <button id="pap-banner-restart" class="primary" type="button"></button>
        </div>
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
          <div class="app-mode-toggle" id="app-mode-toggle" role="group">
            <button type="button" id="app-mode-demo" data-app-mode="demo"></button>
            <button type="button" id="app-mode-pap" data-app-mode="pap"></button>
          </div>
          <div id="demo-task">
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
          </div>
          <div id="pap-task" class="hidden">
            <p id="pap-legend" class="pap-legend"></p>
            <div class="metric-grid">
              <div><span id="pap-metric-placed-label"></span><strong id="pap-placed">0 / 5</strong></div>
              <div><span id="pap-metric-remaining-label"></span><strong id="pap-remaining">5</strong></div>
              <div><span id="pap-metric-time-label"></span><strong id="pap-time">0:00.0</strong></div>
              <div><span id="pap-metric-hold-label"></span><strong id="pap-hold">—</strong></div>
            </div>
            <p id="pap-hint" class="pap-hint"></p>
            <div class="button-row">
              <button id="pap-start" class="primary" type="button"></button>
            </div>
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
let appMode: AppMode = 'demo';
let papTrialActive = false;
let papLatched = false;
let papElapsed = 0;
let papLatches: Latch[] = emptyLatches();
let heldIndex = -1;
let heldLocal: Vec3 = [0, 0, 0];

type FreeJoint = { qposAdr: number; qvelAdr: number };
type PapBindings = {
  stage: FreeJoint;
  handBody: number;
  leftFinger: number;
  rightFinger: number;
  zoneB: Zone;
  cubes: (FreeJoint & { bodyId: number; geomId: number })[];
};
let papBind: PapBindings | null = null;

const SLEEP_ENABLE_BIT = 16;

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

function scalarAt(values: NumericArray, index: number): number {
  return Number(values[index]);
}

function readVec3(values: NumericArray, offset: number): Vec3 {
  return [values[offset], values[offset + 1], values[offset + 2]];
}

function readQuat(values: NumericArray, offset: number): Quat {
  return [values[offset], values[offset + 1], values[offset + 2], values[offset + 3]];
}

function jointAddresses(name: string): FreeJoint {
  if (!engine) throw new Error(`Joint ${name} requested before the engine was ready`);
  const model = engine.runtime.mjModel;
  const jointId = model.jnt(name).id;
  return {
    qposAdr: scalarAt(model.jnt_qposadr, jointId),
    qvelAdr: scalarAt(model.jnt_dofadr, jointId),
  };
}

function writeFreePose(joint: FreeJoint, position: readonly [number, number, number], upright = true): void {
  if (!data) return;
  data.qpos[joint.qposAdr] = position[0];
  data.qpos[joint.qposAdr + 1] = position[1];
  data.qpos[joint.qposAdr + 2] = position[2];
  if (upright) {
    data.qpos[joint.qposAdr + 3] = 1;
    data.qpos[joint.qposAdr + 4] = 0;
    data.qpos[joint.qposAdr + 5] = 0;
    data.qpos[joint.qposAdr + 6] = 0;
  }
  for (let index = 0; index < 6; index += 1) data.qvel[joint.qvelAdr + index] = 0;
}

function setStageZ(z: number): void {
  if (!papBind) return;
  writeFreePose(papBind.stage, [0, 0, z]);
}

function parkPapObjects(): void {
  if (!papBind) return;
  setStageZ(PARK_Z);
  papBind.cubes.forEach((cube, index) => {
    const spawn = CUBE_SPAWN[index];
    writeFreePose(cube, [spawn[0], spawn[1], PARK_Z]);
  });
}

function spawnPapCubes(): void {
  if (!papBind) return;
  setStageZ(0);
  papBind.cubes.forEach((cube, index) => writeFreePose(cube, CUBE_SPAWN[index]));
}

function applyCubeWeight(): void {
  if (!data || !engine || !papBind) return;
  const mass = engine.runtime.mjModel.body_mass;
  for (const cube of papBind.cubes) {
    const base = cube.bodyId * 6;
    for (let axis = 0; axis < 6; axis += 1) data.xfrc_applied[base + axis] = 0;
    const held = heldIndex >= 0 && papBind.cubes[heldIndex] === cube;
    if (appMode === 'pap' && !held) data.xfrc_applied[base + 2] = -scalarAt(mass, cube.bodyId) * 9.81;
  }
}

function lockStage(): void {
  setStageZ(appMode === 'pap' ? 0 : PARK_Z);
}

function handPose(): { position: Vec3; quaternion: Quat } | null {
  if (!data || !papBind) return null;
  return {
    position: readVec3(data.xpos, papBind.handBody * 3),
    quaternion: readQuat(data.xquat, papBind.handBody * 4),
  };
}

function fingerPosition(geomId: number): Vec3 {
  if (!data) return [0, 0, 0];
  return readVec3(data.geom_xpos, geomId * 3);
}

function cubePosition(bodyId: number): Vec3 {
  if (!data) return [0, 0, 0];
  return readVec3(data.xpos, bodyId * 3);
}

function snapHeldCube(): void {
  if (!data || !papBind || heldIndex < 0) return;
  const hand = handPose();
  if (!hand) return;
  const world = worldFromHand(hand.position, hand.quaternion, heldLocal);
  writeFreePose(papBind.cubes[heldIndex], world);
}

function setCubeCollision(index: number, enabled: boolean): void {
  if (!engine || !papBind) return;
  engine.runtime.mjModel.geom_contype[papBind.cubes[index].geomId] = enabled ? 1 : 0;
}

function releaseGrasp(): void {
  if (heldIndex >= 0) setCubeCollision(heldIndex, true);
  heldIndex = -1;
}

function updateGrasp(): void {
  if (!data || !papBind || appMode !== 'pap') {
    releaseGrasp();
    return;
  }
  if (heldIndex >= 0) {
    if (targets[3] >= GRASP_RELEASE) releaseGrasp();
    return;
  }
  // targets[3] moves as soon as J2 close is held, before the pads reach the cube.
  if (targets[3] > GRASP_CLOSE) return;
  const left = fingerPosition(papBind.leftFinger);
  const right = fingerPosition(papBind.rightFinger);
  const cubes = papBind.cubes.map((cube) => cubePosition(cube.bodyId));
  const index = nearestFingerCube([left, right], cubes);
  if (index < 0) return;
  const hand = handPose();
  if (!hand) return;
  heldLocal = handFromWorld(hand.position, hand.quaternion, holdPoint(left, right, cubes[index]));
  heldIndex = index;
  setCubeCollision(index, false);
}

function syncPhysicsPose(): void {
  if (!engine || !data) return;
  engine.runtime.mujoco.mj_forward(engine.runtime.mjModel, data);
  engine.runtime.updateCachedState();
}

function writeArmHome(home: readonly [number, number, number, number]): void {
  if (!data) return;
  targets = [...home];
  for (let index = 0; index < data.qvel.length; index += 1) data.qvel[index] = 0;
  data.qpos[0] = home[0];
  data.qpos[1] = home[1];
  data.qpos[2] = home[2];
  data.qpos[3] = home[3];
  data.qpos[4] = home[3];
}

function resetSimulation(): void {
  if (!engine || !data) return;
  const sim = data;
  clearInput();
  const savedCubes = appMode === 'pap' && papBind
    ? papBind.cubes.map((cube) => Array.from({ length: 7 }, (_, index) => sim.qpos[cube.qposAdr + index]))
    : null;
  releaseGrasp();
  engine.reset();
  writeArmHome(appMode === 'pap' ? PAP_HOME : HOME);
  if (appMode === 'pap' && papBind && savedCubes) {
    setStageZ(0);
    papBind.cubes.forEach((cube, index) => {
      const pose = savedCubes[index];
      for (let offset = 0; offset < 7; offset += 1) sim.qpos[cube.qposAdr + offset] = pose[offset];
    });
  } else {
    parkPapObjects();
  }
  applyTargets();
  syncPhysicsPose();
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

function renderPapHud(): void {
  const text = copy();
  const placed = placedCount(papLatches);
  const placedElement = byId('pap-placed');
  placedElement.textContent = `${placed} / ${CUBE_COUNT}`;
  placedElement.classList.toggle('success-text', placed === CUBE_COUNT);
  byId('pap-remaining').textContent = String(CUBE_COUNT - placed);
  byId('pap-time').textContent = formatElapsed(papElapsed);
  byId('pap-hold').textContent = heldIndex >= 0 ? text.papHolding(heldIndex + 1) : text.papHoldNone;
}

function renderTrialChrome(): void {
  const text = copy();
  if (appMode === 'pap') {
    const phase = papLatched ? 'complete' : papTrialActive ? 'running' : 'idle';
    trialState.textContent = phase === 'complete' ? text.papComplete : phase === 'running' ? text.papRunning : text.papIdle;
    trialState.classList.toggle('complete', phase === 'complete');
    const restartLabel = phase === 'idle' ? text.papStart : text.papRestart;
    byId<HTMLButtonElement>('pap-start').textContent = restartLabel;
    byId<HTMLButtonElement>('pap-banner-restart').textContent = text.papRestart;
    const banner = byId('pap-banner');
    banner.classList.toggle('hidden', phase !== 'complete');
    if (phase === 'complete') {
      byId('pap-banner-title').textContent = text.papBannerTitle;
      byId('pap-banner-detail').textContent = text.papBannerDetail(formatElapsed(papElapsed));
    }
    renderPapHud();
    return;
  }
  const phase = trialComplete ? 'complete' : trialActive ? 'running' : 'idle';
  trialState.textContent = phase === 'complete' ? text.trialComplete : phase === 'running' ? text.trialRunning : text.trialIdle;
  trialState.classList.toggle('complete', phase === 'complete');
  startTrialButton.textContent = phase === 'idle' ? text.startTrial : text.restartTrial;
  if (trialComplete) targetIndexElement.textContent = text.targetDone;
  byId('pap-banner').classList.add('hidden');
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
  byId('viewer-hint').textContent = appMode === 'pap' ? text.viewerHintPap : text.viewerHint;
  byId('task-title').textContent = appMode === 'pap' ? text.papTitle : text.taskTitle;
  byId('app-mode-demo').textContent = text.modeDemo;
  byId('app-mode-pap').textContent = text.modePap;
  byId('app-mode-toggle').setAttribute('aria-label', text.appModeAria);
  byId('app-mode-demo').setAttribute('aria-pressed', appMode === 'demo' ? 'true' : 'false');
  byId('app-mode-pap').setAttribute('aria-pressed', appMode === 'pap' ? 'true' : 'false');
  byId('demo-task').classList.toggle('hidden', appMode !== 'demo');
  byId('pap-task').classList.toggle('hidden', appMode !== 'pap');
  byId('pap-legend').textContent = text.papLegend;
  byId('pap-metric-placed-label').textContent = text.papMetricPlaced;
  byId('pap-metric-remaining-label').textContent = text.papMetricRemaining;
  byId('pap-metric-time-label').textContent = text.papMetricTime;
  byId('pap-metric-hold-label').textContent = text.papMetricHold;
  byId('pap-hint').textContent = text.papHint;
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
  byId('lang-en').setAttribute('aria-pressed', locale === 'en' ? 'true' : 'false');
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

function updatePap(dt: number): void {
  if (!data || !papBind || appMode !== 'pap') return;
  if (!papLatched) {
    const inside = papBind.cubes.map((cube) => {
      const position = cubePosition(cube.bodyId);
      return containsPoint(papBind!.zoneB, position[0], position[1], position[2]);
    });
    stepLatches(papLatches, inside, dt);
    if (papTrialActive && placedCount(papLatches) >= CUBE_COUNT) {
      papLatched = true;
      papTrialActive = false;
      renderTrialChrome();
    }
  }
  if (papTrialActive) papElapsed += dt;
}

function updateTask(dt: number): void {
  if (appMode !== 'demo' || !trialActive || trialComplete) return;
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
  if (!data || appMode !== 'demo' || !trialActive) return;
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

function resetPapTrial(): void {
  if (!data || !papBind) return;
  releaseGrasp();
  papLatches = emptyLatches();
  papElapsed = 0;
  papLatched = false;
  papTrialActive = true;
  clearInput();
  setMode(0, false);
  writeArmHome(PAP_HOME);
  spawnPapCubes();
  applyTargets();
  syncPhysicsPose();
  physicsAccumulator = 0;
  renderTrialChrome();
}

function setAppMode(next: AppMode): void {
  if (!engine || !data || !papBind || next === appMode) return;
  appMode = next;
  releaseGrasp();
  clearInput();
  if (next === 'pap') {
    trialActive = false;
    applyCubeWeight();
    setMode(0, false);
    writeArmHome(PAP_HOME);
    spawnPapCubes();
    papLatches = emptyLatches();
    papElapsed = 0;
    papLatched = false;
    papTrialActive = false;
    engine.camera.set(PAP_CAMERA);
  } else {
    papTrialActive = false;
    papLatched = false;
    applyCubeWeight();
    writeArmHome(HOME);
    parkPapObjects();
    engine.camera.set(DEMO_CAMERA);
  }
  applyTargets();
  syncPhysicsPose();
  physicsAccumulator = 0;
  applyCopy();
  updateTelemetry();
}

function bindPap(): void {
  if (!engine) return;
  const model = engine.runtime.mjModel;
  // Island sleep would ignore a light cube until a hard impact. Keep every cube awake.
  model.opt.enableflags &= ~SLEEP_ENABLE_BIT;
  const zoneGeom = model.geom(ZONE_B_GEOM);
  const cubes = CUBE_NAMES.map((name) => {
    const joint = jointAddresses(`${name}_free`);
    return { ...joint, bodyId: model.body(name).id, geomId: model.geom(`${name}_geom`).id };
  });
  papBind = {
    stage: jointAddresses(STAGE_JOINT),
    handBody: model.body(HAND_BODY).id,
    leftFinger: model.geom(LEFT_FINGER_GEOM).id,
    rightFinger: model.geom(RIGHT_FINGER_GEOM).id,
    zoneB: zoneFromBox(
      [zoneGeom.pos[0], zoneGeom.pos[1], zoneGeom.pos[2]],
      [zoneGeom.size[0], zoneGeom.size[1], zoneGeom.size[2]],
      ZONE_HEIGHT,
    ),
    cubes,
  };
  applyCubeWeight();
  parkPapObjects();
}

function startTrial(): void {
  if (!data || appMode !== 'demo') return;
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
      lockStage();
      snapHeldCube();
      applyCubeWeight();
      applyTargets();
      engine.runtime.mujoco.mj_step(engine.runtime.mjModel, data);
      physicsAccumulator -= PHYSICS_DT;
    }
    snapHeldCube();
    syncPhysicsPose();
    updateGrasp();
    if (heldIndex >= 0) {
      snapHeldCube();
      syncPhysicsPose();
    }
    if (appMode === 'pap') updatePap(dt);
    else {
      updateTask(dt);
      logSample();
    }
    if (now - lastUiUpdate > 50) {
      updateTelemetry();
      if (appMode === 'pap') renderPapHud();
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
byId('frame-camera').addEventListener('click', () => {
  engine?.camera.set(appMode === 'pap' ? PAP_CAMERA : DEMO_CAMERA);
});
startTrialButton.addEventListener('click', startTrial);
byId('pap-start').addEventListener('click', resetPapTrial);
byId('pap-banner-restart').addEventListener('click', resetPapTrial);
document.querySelectorAll<HTMLButtonElement>('[data-app-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    const next = button.dataset.appMode;
    if (next === 'demo' || next === 'pap') setAppMode(next);
  });
});
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
    bindPap();
    resetSimulation();
    // Deliberately keep Mjswan's policy loop paused; update() owns physics stepping.
    enginePhase = 'ready';
    renderStatus();
    startTrialButton.disabled = false;
    byId<HTMLButtonElement>('pap-start').disabled = false;
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
byId<HTMLButtonElement>('pap-start').disabled = true;
requestAnimationFrame(update);
void boot();
