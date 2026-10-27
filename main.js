const CELL = 20;            // 한 칸 크기(px)
const GRID = 20;            // 격자 20x20 (20 * 20 = 400px)
const SIZE = CELL * GRID;   // 화면에 표시되는 크기 400px
const LEVEL_SCORE = 50;     // 이 점수마다 레벨업
const LEVEL_SPEEDUP = 10;   // 레벨업마다 이동 간격을 이만큼(ms) 줄여 빠르게
const MIN_TICK_MS = 20;     // 이동 간격의 하한 (너무 빨라지는 것 방지)
const HIGH_SCORE_KEY = 'snakeHighScore';

// 고해상도: 실제 캔버스 픽셀을 2배 이상으로 키우고 좌표계는 400 기준으로 유지
const SCALE = Math.max(2, Math.ceil(window.devicePixelRatio || 1));

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
canvas.width = SIZE * SCALE;
canvas.height = SIZE * SCALE;
ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);

const scoreEl = document.getElementById('score');
const highScoreEl = document.getElementById('high-score');
const messageEl = document.getElementById('message');
const startBtn = document.getElementById('start-btn');
const soundBtn = document.getElementById('sound-btn');
const pauseBtn = document.getElementById('pause-btn');
const levelEl = document.getElementById('level');
const difficultyEl = document.getElementById('difficulty');

let snake = [];   // 뱀 몸통 좌표 배열 (0번이 머리)
let direction;    // 현재 이동 방향
let nextDir;      // 다음 틱에 적용할 방향 (한 틱에 역방향 전환 방지)
let food = { x: -1, y: -1 };
let score = 0;
let dead = false;
let playing = false;   // 게임 진행 중 (일시정지 포함)
let paused = false;
let level = 1;
let baseTick = 150;    // 선택한 난이도의 기본 이동 간격(ms)
let highScore = loadHighScore();
let timer = null;

// ---------- 최고 점수 ----------

function loadHighScore() {
  try {
    return parseInt(localStorage.getItem(HIGH_SCORE_KEY), 10) || 0;
  } catch (e) {
    return 0;
  }
}

function saveHighScore() {
  try {
    localStorage.setItem(HIGH_SCORE_KEY, String(highScore));
  } catch (e) {
    // 저장 실패해도 게임은 계속 진행
  }
}

// ---------- 소리 (Web Audio로 직접 합성, 별도 파일 없음) ----------

let audioCtx = null;
let master = null;
let muted = false;
let musicTimer = null;
let nextNoteTime = 0;
let step = 0;

const STEP_SEC = 0.13;
// 통통 튀는 멜로디(C 메이저 펜타토닉), 0은 쉼표
const MELODY = [
  659, 784, 880, 784, 659, 587, 523, 0,
  587, 659, 784, 659, 587, 523, 587, 0,
  659, 784, 880, 1047, 880, 784, 659, 784,
  880, 784, 659, 587, 523, 587, 523, 0,
];
// 박자마다 바뀌는 베이스
const BASS = [131, 110, 87, 98];

function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    audioCtx = new AC();
    master = audioCtx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return true;
}

// 지정한 시각에 짧은 음 하나를 재생
function tone(freq, when, dur, type, vol) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, when);
  gain.gain.setValueAtTime(vol, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + dur);
  osc.connect(gain);
  gain.connect(master);
  osc.start(when);
  osc.stop(when + dur + 0.02);
}

// 조금 앞선 시간까지 음을 미리 예약해 박자가 흔들리지 않게 함
function scheduleMusic() {
  while (nextNoteTime < audioCtx.currentTime + 0.25) {
    const note = MELODY[step % MELODY.length];
    if (note) tone(note, nextNoteTime, STEP_SEC * 0.9, 'square', 0.05);
    if (step % 4 === 0) {
      const bass = BASS[(step / 4) % BASS.length];
      tone(bass, nextNoteTime, STEP_SEC * 3.5, 'triangle', 0.16);
    }
    nextNoteTime += STEP_SEC;
    step++;
  }
}

function startMusic() {
  if (!ensureAudio()) return;
  stopMusic();
  step = 0;
  nextNoteTime = audioCtx.currentTime + 0.05;
  scheduleMusic();
  musicTimer = setInterval(scheduleMusic, 50);
}

// 일시정지 후 이어서 재생 (처음부터 다시 시작하지 않음)
function resumeMusic() {
  if (!audioCtx || musicTimer) return;
  nextNoteTime = audioCtx.currentTime + 0.05;
  musicTimer = setInterval(scheduleMusic, 50);
}

function stopMusic() {
  clearInterval(musicTimer);
  musicTimer = null;
}

// 먹이를 먹었을 때: 올라가는 뾰로롱
function playEat() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  tone(784, t, 0.08, 'square', 0.08);
  tone(1047, t + 0.07, 0.08, 'square', 0.08);
  tone(1568, t + 0.14, 0.14, 'square', 0.08);
}

// 죽었을 때: 스프링처럼 튀는 "띠용"
function playBoing() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';

  // 위아래로 출렁이며 점점 잦아드는 음높이
  const pitch = [
    [0, 160], [0.07, 950], [0.2, 260], [0.32, 720],
    [0.44, 330], [0.55, 560], [0.66, 380], [0.75, 450],
  ];
  osc.frequency.setValueAtTime(pitch[0][1], t);
  for (let i = 1; i < pitch.length; i++) {
    osc.frequency.linearRampToValueAtTime(pitch[i][1], t + pitch[i][0]);
  }

  gain.gain.setValueAtTime(0.35, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.85);
  osc.connect(gain);
  gain.connect(master);
  osc.start(t);
  osc.stop(t + 0.9);
}

soundBtn.addEventListener('click', () => {
  muted = !muted;
  soundBtn.textContent = muted ? '소리 켜기' : '소리 끄기';
  if (master) master.gain.value = muted ? 0 : 1;
});

// ---------- 그리기 ----------

const center = (p) => ({ x: p.x * CELL + CELL / 2, y: p.y * CELL + CELL / 2 });

// 잔디 바닥 (체크무늬)
function drawGrass() {
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#4ade80' : '#43c874';
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }
}

// 사과: 빨간 몸통, 하이라이트, 줄기와 잎
function drawApple(pos) {
  if (pos.x < 0) return;
  const c = center(pos);
  const bob = Math.sin(Date.now() / 250) * 0.6; // 살짝 위아래로 흔들림

  ctx.save();
  ctx.translate(c.x, c.y + bob);

  // 그림자
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.beginPath();
  ctx.ellipse(0, 8, 6, 2, 0, 0, Math.PI * 2);
  ctx.fill();

  // 몸통 (위가 살짝 들어간 사과 모양)
  const grad = ctx.createRadialGradient(-3, -3, 1, 0, 1, 10);
  grad.addColorStop(0, '#ff6b6b');
  grad.addColorStop(0.6, '#e11d2e');
  grad.addColorStop(1, '#9b1020');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, -5);
  ctx.bezierCurveTo(-3, -9, -10, -6, -9, 1);
  ctx.bezierCurveTo(-8, 8, -3, 10, 0, 8);
  ctx.bezierCurveTo(3, 10, 8, 8, 9, 1);
  ctx.bezierCurveTo(10, -6, 3, -9, 0, -5);
  ctx.fill();

  // 하이라이트
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.beginPath();
  ctx.ellipse(-4.5, -2, 1.6, 3, -0.4, 0, Math.PI * 2);
  ctx.fill();

  // 줄기
  ctx.strokeStyle = '#6b4423';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -5);
  ctx.quadraticCurveTo(0.5, -8, 2, -10);
  ctx.stroke();

  // 잎
  ctx.fillStyle = '#16a34a';
  ctx.beginPath();
  ctx.moveTo(1, -8);
  ctx.quadraticCurveTo(5, -12, 9, -8);
  ctx.quadraticCurveTo(5, -5, 1, -8);
  ctx.fill();

  ctx.restore();
}

// 뱀: 꼬리로 갈수록 가늘어지는 몸통, 비늘 무늬, 눈과 혀가 있는 머리
function drawSnake() {
  const n = snake.length;
  if (n === 0) return;
  const pts = snake.map(center);
  const width = (i) => 17 - (n > 1 ? (i / (n - 1)) * 6 : 0);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 몸통 그림자
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
  for (let i = n - 1; i >= 1; i--) {
    ctx.lineWidth = width(i) + 2;
    ctx.beginPath();
    ctx.moveTo(pts[i].x + 1.5, pts[i].y + 2);
    ctx.lineTo(pts[i - 1].x + 1.5, pts[i - 1].y + 2);
    ctx.stroke();
  }

  // 외곽선 → 몸 색 → 등 쪽 밝은 줄
  const layers = [
    { color: '#14532d', extra: 2.5, ratio: 1 },
    { color: dead ? '#6b8f5e' : '#2f9e44', extra: 0, ratio: 1 },
    { color: dead ? '#a3bf98' : '#86e08f', extra: 0, ratio: 0.35 },
  ];
  layers.forEach((layer) => {
    ctx.strokeStyle = layer.color;
    for (let i = n - 1; i >= 1; i--) {
      ctx.lineWidth = width(i) * layer.ratio + layer.extra;
      ctx.beginPath();
      ctx.moveTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[i - 1].x, pts[i - 1].y);
      ctx.stroke();
    }
  });

  // 비늘(마름모) 무늬
  ctx.fillStyle = dead ? '#4b6b40' : '#14532d';
  for (let i = 2; i < n; i += 2) {
    const s = width(i) * 0.3;
    ctx.beginPath();
    ctx.moveTo(pts[i].x, pts[i].y - s);
    ctx.lineTo(pts[i].x + s, pts[i].y);
    ctx.lineTo(pts[i].x, pts[i].y + s);
    ctx.lineTo(pts[i].x - s, pts[i].y);
    ctx.closePath();
    ctx.fill();
  }

  drawHead(pts[0], n > 1 ? pts[1] : null);
}

function drawHead(head, neck) {
  // 진행 방향(목 → 머리)으로 머리를 돌림
  const dx = neck ? head.x - neck.x : direction ? direction.x : 1;
  const dy = neck ? head.y - neck.y : direction ? direction.y : 0;
  const angle = Math.atan2(dy, dx);

  ctx.save();
  ctx.translate(head.x, head.y);
  ctx.rotate(angle);

  // 혀: 주기적으로 날름거림
  if (!dead && Math.floor(Date.now() / 350) % 2 === 0) {
    ctx.strokeStyle = '#e11d48';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(15, 0);
    ctx.moveTo(15, 0);
    ctx.lineTo(18, -2.5);
    ctx.moveTo(15, 0);
    ctx.lineTo(18, 2.5);
    ctx.stroke();
  }

  // 머리
  ctx.fillStyle = dead ? '#6b8f5e' : '#2f9e44';
  ctx.strokeStyle = '#14532d';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(2, 0, 11, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // 눈
  [-5, 5].forEach((ey) => {
    if (dead) {
      // 죽으면 X 모양 눈
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(3, ey - 2);
      ctx.lineTo(7, ey + 2);
      ctx.moveTo(7, ey - 2);
      ctx.lineTo(3, ey + 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#fef08a';
      ctx.beginPath();
      ctx.arc(5, ey, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.ellipse(5.8, ey, 0.9, 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // 콧구멍
  ctx.fillStyle = '#14532d';
  ctx.beginPath();
  ctx.arc(10, -2, 0.8, 0, Math.PI * 2);
  ctx.arc(10, 2, 0.8, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function draw() {
  drawGrass();
  drawApple(food);
  drawSnake();
}

// 혀와 사과 흔들림이 부드럽게 보이도록 계속 다시 그림
function frame() {
  draw();
  requestAnimationFrame(frame);
}

// ---------- 게임 로직 ----------

function updateScore() {
  scoreEl.textContent = score;
  highScoreEl.textContent = highScore;
  levelEl.textContent = level;
}

// 현재 이동 간격: 난이도 기본값에서 레벨마다 10ms씩 줄어듦
function tickMs() {
  return Math.max(MIN_TICK_MS, baseTick - (level - 1) * LEVEL_SPEEDUP);
}

function startTimer() {
  clearInterval(timer);
  timer = setInterval(tick, tickMs());
}

// 뱀과 겹치지 않는 임의의 칸에 먹이 생성
function placeFood() {
  let pos;
  do {
    pos = {
      x: Math.floor(Math.random() * GRID),
      y: Math.floor(Math.random() * GRID),
    };
  } while (snake.some((s) => s.x === pos.x && s.y === pos.y));
  food = pos;
}

// 한 칸 이동 (게임 규칙 처리)
function tick() {
  direction = nextDir;
  const head = {
    x: snake[0].x + direction.x,
    y: snake[0].y + direction.y,
  };

  // 벽 충돌
  const hitWall = head.x < 0 || head.x >= GRID || head.y < 0 || head.y >= GRID;
  // 자기 몸 충돌 (꼬리는 이번 틱에 빠지므로 제외)
  const willEat = head.x === food.x && head.y === food.y;
  const body = willEat ? snake : snake.slice(0, -1);
  const hitSelf = body.some((s) => s.x === head.x && s.y === head.y);

  if (hitWall || hitSelf) {
    gameOver();
    return;
  }

  snake.unshift(head);

  if (willEat) {
    score += 10;
    if (score > highScore) {
      highScore = score;
      saveHighScore();
    }
    // 50점마다 레벨업 → 이동 간격이 줄어들도록 타이머 재설정
    const newLevel = Math.floor(score / LEVEL_SCORE) + 1;
    if (newLevel > level) {
      level = newLevel;
      startTimer();
    }
    updateScore();
    playEat();
    placeFood();
  } else {
    snake.pop();
  }
}

function startGame() {
  snake = [
    { x: 10, y: 10 },
    { x: 9, y: 10 },
    { x: 8, y: 10 },
  ];
  direction = { x: 1, y: 0 };
  nextDir = direction;
  score = 0;
  dead = false;
  level = 1;
  baseTick = parseInt(difficultyEl.value, 10);
  playing = true;
  paused = false;
  messageEl.textContent = '';
  startBtn.classList.add('hidden');
  pauseBtn.textContent = '일시정지';
  pauseBtn.classList.remove('hidden');
  difficultyEl.disabled = true; // 게임 중에는 난이도 변경 불가

  placeFood();
  updateScore();

  startTimer();
  startMusic();
}

// 일시정지 / 재개
function togglePause() {
  if (!playing) return;
  paused = !paused;

  if (paused) {
    clearInterval(timer);
    timer = null;
    stopMusic();
    messageEl.textContent = '일시정지';
    pauseBtn.textContent = '재개';
  } else {
    startTimer();
    resumeMusic();
    messageEl.textContent = '';
    pauseBtn.textContent = '일시정지';
  }
}

function gameOver() {
  clearInterval(timer);
  timer = null;
  playing = false;
  paused = false;
  pauseBtn.classList.add('hidden');
  difficultyEl.disabled = false;
  dead = true;
  stopMusic();
  playBoing();
  messageEl.textContent = `게임 오버! 점수: ${score}`;
  startBtn.textContent = '다시 시작';
  startBtn.classList.remove('hidden');
}

// 방향키 입력: 현재 방향의 정반대로는 전환 불가
document.addEventListener('keydown', (e) => {
  const dirs = {
    ArrowUp: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 },
    ArrowLeft: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
  };
  const d = dirs[e.key];
  if (!d) return;

  e.preventDefault(); // 방향키로 페이지가 스크롤되지 않도록
  if (!playing || paused) return;
  if (d.x === -direction.x && d.y === -direction.y) return;
  nextDir = d;
});

startBtn.addEventListener('click', startGame);
pauseBtn.addEventListener('click', togglePause);

// 시작 전 화면: 빈 잔디와 최고 점수 표시
updateScore();
frame();
