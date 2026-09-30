export type Locale = 'ja' | 'zh';

export type Copy = {
  htmlLang: string;
  title: string;
  description: string;
  loading: string;
  ready: string;
  loadFailed: string;
  modelDownloadFailed: (status: number) => string;
  noMjData: string;
  noEndEffector: string;
  viewerHint: string;
  taskTitle: string;
  trialIdle: string;
  trialRunning: string;
  trialComplete: string;
  metricTarget: string;
  metricError: string;
  metricDwell: string;
  metricSwitches: string;
  targetDone: string;
  startTrial: string;
  restartTrial: string;
  downloadCsv: string;
  modeJ1Badge: string;
  modeJ2Badge: string;
  modeJ1Title: string;
  modeJ2Title: string;
  joyAria: string;
  labelFlexion: string;
  labelExtension: string;
  labelAbduction: string;
  labelAdduction: string;
  labelForearmForward: string;
  labelForearmBack: string;
  labelHandOpen: string;
  labelHandClose: string;
  reset: string;
  frameCamera: string;
  telemetryTitle: string;
  joints: readonly [string, string, string, string];
  disclaimer: string;
  langAria: string;
};

const ja: Copy = {
  htmlLang: 'ja',
  title: '肩義手バーチャル制御実験',
  description: '肩義手・4自由度の MuJoCo/Mjswan ブラウザ制御実験プロトタイプ',
  loading: 'モデルを読み込み中',
  ready: 'シミュレーション準備完了',
  loadFailed: '読み込み失敗',
  modelDownloadFailed: (status) => `モデルのダウンロードに失敗しました：HTTP ${status}`,
  noMjData: 'Mjswan は読み込まれましたが、MuJoCo の状態を取得できません。',
  noEndEffector: 'モデル内に end_effector site が見つかりません。',
  viewerHint: 'ドラッグで回転 · ホイールでズーム · 赤い球が目標',
  taskTitle: '目標到達実験',
  trialIdle: '未開始',
  trialRunning: '実施中',
  trialComplete: '完了',
  metricTarget: '目標',
  metricError: '手先誤差',
  metricDwell: '滞留',
  metricSwitches: '切替回数',
  targetDone: '完了',
  startTrial: '実験開始',
  restartTrial: '再開始',
  downloadCsv: 'CSVをダウンロード',
  modeJ1Badge: 'J1 · 肩',
  modeJ2Badge: 'J2 · 前腕 / 手',
  modeJ1Title: 'J1 · 肩屈曲・伸展 / 外転・内転',
  modeJ2Title: 'J2 · 前腕前後 / 手の開閉',
  joyAria: 'タッチ方向操作',
  labelFlexion: '肩屈曲',
  labelExtension: '肩伸展',
  labelAbduction: '肩外転',
  labelAdduction: '肩内転',
  labelForearmForward: '前腕前',
  labelForearmBack: '前腕後',
  labelHandOpen: '手を開く',
  labelHandClose: '手を閉じる',
  reset: 'リセット',
  frameCamera: '視点リセット',
  telemetryTitle: '関節のリアルタイム状態',
  joints: ['肩屈曲・伸展', '肩外転・内転', '前腕前後', '手の開閉'],
  disclaimer:
    '等価運動学プロトタイプです。形状、回転軸、可動範囲、動力学パラメータは、実機の Fusion 機構では未検証です。',
  langAria: '表示言語',
};

const zh: Copy = {
  htmlLang: 'zh-CN',
  title: '肩义手虚拟控制实验',
  description: '肩义手四自由度 MuJoCo/Mjswan 浏览器控制实验原型',
  loading: '正在加载模型',
  ready: '仿真已就绪',
  loadFailed: '加载失败',
  modelDownloadFailed: (status) => `模型下载失败：HTTP ${status}`,
  noMjData: 'Mjswan 已加载，但无法取得 MuJoCo 状态。',
  noEndEffector: '模型中找不到 end_effector site。',
  viewerHint: '拖动旋转 · 滚轮缩放 · 红球为任务目标',
  taskTitle: '目标到达实验',
  trialIdle: '未开始',
  trialRunning: '进行中',
  trialComplete: '已完成',
  metricTarget: '目标',
  metricError: '末端误差',
  metricDwell: '停留',
  metricSwitches: '切换次数',
  targetDone: '完成',
  startTrial: '开始实验',
  restartTrial: '重新开始',
  downloadCsv: '下载 CSV',
  modeJ1Badge: 'J1 · 肩部',
  modeJ2Badge: 'J2 · 前臂 / 手',
  modeJ1Title: 'J1 · 肩屈伸 / 肩外展内收',
  modeJ2Title: 'J2 · 前臂前后 / 手部开闭',
  joyAria: '触屏方向控制',
  labelFlexion: '肩屈曲',
  labelExtension: '肩伸展',
  labelAbduction: '肩外展',
  labelAdduction: '肩内收',
  labelForearmForward: '前臂前',
  labelForearmBack: '前臂后',
  labelHandOpen: '手打开',
  labelHandClose: '手闭合',
  reset: '复位',
  frameCamera: '重新取景',
  telemetryTitle: '实时关节状态',
  joints: ['肩屈伸', '肩外展/内收', '前臂前后', '手部开闭'],
  disclaimer: '等效运动学原型：几何、轴线、限位和动力学参数尚未由真实 Fusion 机构验证。',
  langAria: '界面语言',
};

export const COPY: Record<Locale, Copy> = { ja, zh };

const STORAGE_KEY = 'shoulder-ui-locale';

export function isLocale(value: string | null): value is Locale {
  return value === 'ja' || value === 'zh';
}

export function loadLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Storage can be unavailable in private browsing.
  }
  return 'ja';
}

export function saveLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Ignore quota and privacy errors; the in-memory choice still applies.
  }
}
