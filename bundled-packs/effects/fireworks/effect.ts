/**
 * fireworks — 1 発の花火 bundled Effect Pack（rise → burst の 2 段階）を
 * **GPU シェーダー**で描く版。
 *
 * `ctx.renderer.drawOnGLCanvas` で全画面 WebGL2 overlay を acquire し、粒の
 * 物理を頂点シェーダーで毎フレーム解析的に解く（CPU で 1 粒ずつ位置を更新
 * しない）。結果、数百〜千を超える発光粒を加算合成しても 60fps を保てる。
 *
 * ## なぜ GPU か
 *
 * 旧版は 2D canvas に `arc()` を粒数ぶん描いていたため、見栄えを上げようと
 * 粒を増やすと CPU と描画呼び出しが線形に重くなる。GPU 版は粒の状態を
 * attribute buffer に 1 度だけ積み、頂点シェーダーが `pos = p0 + v·damp(t)
 * + ½·g·t²` を全粒並列に評価する。CPU は毎フレーム時刻 uniform を更新する
 * だけ。粒数は描画コストにほぼ効かない。
 *
 * ## 物理（頂点シェーダー内・解析解）
 *
 * - **drag**: 指数減衰 `v(t)=v0·e^{-t/τ}` の変位閉形式 `v0·τ·(1−e^{-t/τ})`。
 *   爆発直後に速く開き、τ で滑らかに減速する。
 * - **gravity**: `½·g·t²` を y（画面下向き）に加える。
 * - **life/alpha**: `(1−t/maxLife)²` に twinkle（正弦のちらつき）を乗じる。
 * - **flash**: 爆発直後だけ `e^{-8t}` の輝度ブーストを足し、芯が白く飛ぶ。
 *
 * ## トレイル（fade-feedback / ping-pong FBO）
 *
 * 旧版の `destination-out` による残像を GPU で再現する。2 枚の RGBA8
 * テクスチャを ping-pong し、毎フレーム「前フレームを `×TRAIL_FADE` して
 * 写し → その上に現在の粒を加算 → 画面へ提示」する。ロケットの軌跡も
 * 爆発粒の尾も、この減衰バッファが自然な光の尾として残す。
 *
 * ## 色は coherent family
 *
 * 1 発ごとに base hue を random で決め、粒は seed で ±`HUE_SPREAD` 揺らぐ。
 * フラグメント側で芯ほど白へ寄せ、白熱した核と色づいた縁を作る。
 *
 * ## 合成（premultiplied additive）
 *
 * context は premultipliedAlpha。フラグメントは premultiplied 色
 * `vec4(rgb·a, a)` を出力し `blendFunc(ONE,ONE)` で加算する。alpha も蓄積
 * されるので、overlay は mix-blend-mode に依存せず terminal/VRM の上へ正しく
 * 合成される（明るい所は発光が乗り、減衰すれば下が透ける）。
 *
 * ## graceful degradation
 *
 * WebGL2 が無い環境（headless / 一部 webview）では drawOnGLCanvas の draw
 * callback が呼ばれず、RAF も起動しない。lifecycle（durationMs 待ち →
 * dispose）だけは必ず守る。GL resource の確保に失敗した場合も同様に no-op。
 *
 * ## 肌触り parameter（帰納的に調整する領域）
 *
 * RISE_MS / WOBBLE_* / TRAIL_* / GRAVITY / DRAG_TAU / SPEED_* / LIFE_* /
 * SIZE_* / DENSITY は spec に固定せず、観察→微調整で固める（CLAUDE.md
 * 「感触 parameter は帰納的に」）。
 *
 * 連発は呼び出し側（persona / init.js / fireworks-volley）が複数回刻む責務。
 * この pack は 1 origin からの 1 発に集中する。
 */

import type { EffectContext, EffectDefinition, Vec2 } from "@charminal/sdk";

interface FireworksOptions {
  readonly origin: Vec2;
  readonly count: number;
  readonly durationMs: number;
}

// ─── lifecycle timing（旧版と同じ契約）──────────────────────

/** rise phase の基準所要時間（ms）。実際は ±RISE_JITTER_MS 揺らぐ。 */
const RISE_MS = 2000;
const RISE_JITTER_MS = 100;
/** burst 後の粒が自然に fade しきるまでの buffer（ms）。LIFE 上限と trail の
 *  減衰を見込んで余裕を取る。 */
const BURST_FADE_TAIL_MS = 2600;
/** 1 発が natural に演じ終わるまでの最低所要時間。options.durationMs がこれを
 *  下回る場合、pack が延長して burst が途中で切れないようにする。 */
const MIN_EFFECT_MS = RISE_MS + RISE_JITTER_MS + BURST_FADE_TAIL_MS;

// ─── 見た目 / 物理の肌触り parameter ────────────────────────

/** rocket の start 位置を origin y から画面下へどれだけ外すか（CSS px 基準）。 */
const START_Y_OFFSET = 30;
/** rise 中の左右揺らぎのサイクル数（片道で何回振る）。 */
const WOBBLE_CYCLES = 5;
/** 左右揺らぎの最大振幅（CSS px 基準）、t=0 で最大、apex で 0 に収束。 */
const WOBBLE_AMPLITUDE = 7;
/** 毎フレーム trail を残す割合（大きいほど尾が長い）。 */
const TRAIL_FADE = 0.92;
/** trail を確実に 0 へ落とすための減算項（8bit の量子化で消え残るのを防ぐ）。 */
const TRAIL_FLOOR = 0.009;
/** 重力（px/s²、画面下向き）。画面解像度でスケールする。 */
const GRAVITY = 520;
/** drag の時定数（s）。小さいほど早く失速する。 */
const DRAG_TAU = 0.9;
/** 爆発粒の初速レンジ（px/s、画面解像度でスケール）。 */
const SPEED_MIN = 130;
const SPEED_MAX = 680;
/** 粒寿命レンジ（s）。長めに取って bloom を画面に残す。 */
const LIFE_MIN = 1.3;
const LIFE_MAX = 3.0;
/** 粒の基準サイズレンジ（CSS px 基準、稀に大きな星を混ぜる）。発光感のため太め。 */
const SIZE_MIN = 3.2;
const SIZE_MAX = 7.5;
/** options.count に対する実 GPU 粒数の倍率。GPU は粒数にほぼ無依存なので、
 *  見栄えのために増やす。総数は MIN/MAX でクランプ。 */
const DENSITY = 14;
const PARTICLE_MIN = 260;
const PARTICLE_MAX = 2000;
/** base hue からの揺らぎ幅（0-1 hue 空間、±この値）。 */
const HUE_SPREAD = 0.06;
/** 解像度スケールの基準高さ（px）。buffer 高さ / これでサイズ・速度を倍率。 */
const REFERENCE_HEIGHT = 900;
/** rocket の発光点数（head + sparks）。trail バッファが尾を作るので少数で足りる。 */
const ROCKET_POINTS = 3;

/**
 * ease-out quad: 1 − (1−t)² = 2t − t²。
 * 一定重力下の投射運動（初速で打ち上げ、重力で減速、apex で v=0）の y 成分と
 * 一致する curve。rise の高さ補間に使う。
 */
const easeOutQuad = (t: number): number => 1 - (1 - t) ** 2;

// ─── shader sources（GLSL ES 3.00 / WebGL2）────────────────

/** 全画面三角形。gl_VertexID から clip 座標を出すので頂点 buffer 不要。 */
const QUAD_VS = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  v_uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/** テクスチャを `×u_fade − u_floor`（clamp ≥0）で写す。fade-copy と present 兼用。 */
const QUAD_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_fade;
uniform float u_floor;
in vec2 v_uv;
out vec4 frag;
void main() {
  vec4 c = texture(u_tex, v_uv) * u_fade - u_floor;
  frag = max(c, vec4(0.0));
}`;

/**
 * 発光粒。位置・寿命・色を頂点シェーダーで解析的に解く。
 * a_position は基準点（爆発は origin、ロケットは head の現在位置）。
 */
const POINT_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_velocity;
layout(location = 2) in float a_seed;
layout(location = 3) in float a_maxLife;
layout(location = 4) in float a_size;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_gravity;
uniform float u_tau;
uniform float u_baseHue;
uniform float u_hueSpread;
uniform float u_sizeMax;

out float v_alpha;
out vec3 v_color;

vec3 hue2rgb(float h) {
  h = fract(h);
  float r = abs(h * 6.0 - 3.0) - 1.0;
  float g = 2.0 - abs(h * 6.0 - 2.0);
  float b = 2.0 - abs(h * 6.0 - 4.0);
  return clamp(vec3(r, g, b), 0.0, 1.0);
}

void main() {
  float t = max(u_time, 0.0);
  // drag の変位閉形式 + gravity（y は画面下向き px）。
  float damp = u_tau * (1.0 - exp(-t / u_tau));
  vec2 pos = a_position + a_velocity * damp;
  pos.y += 0.5 * u_gravity * t * t;

  float life = clamp(t / a_maxLife, 0.0, 1.0);
  float fade = 1.0 - life;
  // twinkle（粒ごとに位相と周期を散らす）。
  float tw = 0.82 + 0.18 * sin(t * (7.0 + a_seed * 13.0) + a_seed * 31.4);
  // 爆発直後の白熱ブースト。
  float flash = 1.0 + 2.4 * exp(-t * 7.0);
  // fade^1.25 で bloom を fade² より長く保つ。
  v_alpha = pow(fade, 1.25) * tw * flash;

  float hue = u_baseHue + (a_seed - 0.5) * u_hueSpread;
  v_color = hue2rgb(hue);

  // px(y 下向き) → clip。
  vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = clamp(a_size * (0.58 + 0.42 * fade), 2.0, u_sizeMax);
}`;

/** 円形ソフトグロー。premultiplied 加算用に `vec4(rgb·a, a)` を出力。 */
const POINT_FS = `#version 300 es
precision highp float;
in float v_alpha;
in vec3 v_color;
out vec4 frag;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;          // 0=中心, 1=縁
  if (r > 1.0) discard;
  float core = smoothstep(1.0, 0.0, r);
  // 鋭い芯 + 広いハローの二層で発光感を強める。
  float glow = pow(core, 1.7) + 0.45 * pow(core, 5.0);
  float a = glow * v_alpha;
  if (a <= 0.003) discard;
  // 芯ほど白熱、全体の輝度を底上げ。
  vec3 c = mix(v_color, vec3(1.0), core * core * 0.75) * 1.35;
  frag = vec4(c * a, a);
}`;

// ─── GL helpers ────────────────────────────────────────────

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("[fireworks] shader compile failed:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // shader は program に紐付いたので個別参照は捨ててよい。
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("[fireworks] program link failed:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

interface RenderTarget {
  readonly tex: WebGLTexture;
  readonly fbo: WebGLFramebuffer;
}

/** RGBA8 の color-attachment 付き framebuffer を 1 枚作り、透明にクリアする。 */
function createTarget(gl: WebGL2RenderingContext, w: number, h: number): RenderTarget | null {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(tex);
    gl.deleteFramebuffer(fbo);
    return null;
  }
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return { tex, fbo };
}

/** 1 粒あたりの interleave float 数（pos2, vel2, seed, maxLife, size）。 */
const STRIDE_FLOATS = 7;

/** attribute location（POINT_VS の layout と一致させる）。 */
const ATTR = { position: 0, velocity: 1, seed: 2, maxLife: 3, size: 4 } as const;

/** interleave buffer を attribute へ結線する VAO を作る。 */
function createPointVao(
  gl: WebGL2RenderingContext,
  buffer: WebGLBuffer,
): WebGLVertexArrayObject | null {
  const vao = gl.createVertexArray();
  if (!vao) return null;
  const stride = STRIDE_FLOATS * 4;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(ATTR.position);
  gl.vertexAttribPointer(ATTR.position, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(ATTR.velocity);
  gl.vertexAttribPointer(ATTR.velocity, 2, gl.FLOAT, false, stride, 8);
  gl.enableVertexAttribArray(ATTR.seed);
  gl.vertexAttribPointer(ATTR.seed, 1, gl.FLOAT, false, stride, 16);
  gl.enableVertexAttribArray(ATTR.maxLife);
  gl.vertexAttribPointer(ATTR.maxLife, 1, gl.FLOAT, false, stride, 20);
  gl.enableVertexAttribArray(ATTR.size);
  gl.vertexAttribPointer(ATTR.size, 1, gl.FLOAT, false, stride, 24);
  gl.bindVertexArray(null);
  return vao;
}

interface Scene {
  renderFrame(elapsedMs: number): void;
  dispose(): void;
}

/**
 * WebGL2 の program / buffer / FBO を組み立て、毎フレーム描く Scene を返す。
 * 何か 1 つでも確保に失敗したら null（呼び出し側は no-op に倒す）。
 */
function setupScene(gl: WebGL2RenderingContext, options: FireworksOptions): Scene | null {
  const W = gl.drawingBufferWidth;
  const H = gl.drawingBufferHeight;
  if (W <= 0 || H <= 0) return null;
  // buffer は HiDPI 込みの実 pixel。基準高さで割って px 量をスケールする。
  const scale = H / REFERENCE_HEIGHT;
  const sizeMax = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null)?.[1] ?? 64;

  const quadProgram = linkProgram(gl, QUAD_VS, QUAD_FS);
  const pointProgram = linkProgram(gl, POINT_VS, POINT_FS);
  if (!quadProgram || !pointProgram) return null;

  let targetA = createTarget(gl, W, H);
  let targetB = createTarget(gl, W, H);
  const emptyVao = gl.createVertexArray();
  const burstBuffer = gl.createBuffer();
  const rocketBuffer = gl.createBuffer();
  if (!targetA || !targetB || !emptyVao || !burstBuffer || !rocketBuffer) return null;

  const burstVao = createPointVao(gl, burstBuffer);
  const rocketVao = createPointVao(gl, rocketBuffer);
  if (!burstVao || !rocketVao) return null;

  // uniform locations。
  const qTex = gl.getUniformLocation(quadProgram, "u_tex");
  const qFade = gl.getUniformLocation(quadProgram, "u_fade");
  const qFloor = gl.getUniformLocation(quadProgram, "u_floor");
  const pRes = gl.getUniformLocation(pointProgram, "u_resolution");
  const pTime = gl.getUniformLocation(pointProgram, "u_time");
  const pGravity = gl.getUniformLocation(pointProgram, "u_gravity");
  const pTau = gl.getUniformLocation(pointProgram, "u_tau");
  const pBaseHue = gl.getUniformLocation(pointProgram, "u_baseHue");
  const pHueSpread = gl.getUniformLocation(pointProgram, "u_hueSpread");
  const pSizeMax = gl.getUniformLocation(pointProgram, "u_sizeMax");

  // 1 発ぶんの色と動きの揺らぎ。
  const baseHue = Math.random();
  const wobbleDir = Math.random() < 0.5 ? 1 : -1;
  const actualRiseMs = RISE_MS + (Math.random() * 2 - 1) * RISE_JITTER_MS;
  const targetX = options.origin.x * W;
  const targetY = options.origin.y * H;
  const startY = H + START_Y_OFFSET * scale;

  // 爆発粒の attribute を生成（origin から全方向へ）。一部は低速で長寿命の
  // 残り火、一部は高速の殻。
  const particleCount = Math.max(
    PARTICLE_MIN,
    Math.min(PARTICLE_MAX, Math.round(options.count * DENSITY)),
  );
  const burstData = new Float32Array(particleCount * STRIDE_FLOATS);
  for (let i = 0; i < particleCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    // sqrt 分布で外殻に粒を寄せ、丸い burst に見せる。30% は低速の残り火。
    const isEmber = Math.random() < 0.3;
    const speedT = isEmber ? Math.random() * 0.35 : 0.35 + Math.sqrt(Math.random()) * 0.65;
    const speed = (SPEED_MIN + (SPEED_MAX - SPEED_MIN) * speedT) * scale;
    const maxLife = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN) + (isEmber ? 0.4 : 0);
    // 稀に大きな星。
    const sizeBase = SIZE_MIN + Math.random() * (SIZE_MAX - SIZE_MIN);
    const size = (Math.random() < 0.04 ? sizeBase * 2.2 : sizeBase) * scale;
    const o = i * STRIDE_FLOATS;
    burstData[o] = targetX;
    burstData[o + 1] = targetY;
    burstData[o + 2] = Math.cos(angle) * speed;
    burstData[o + 3] = Math.sin(angle) * speed;
    burstData[o + 4] = Math.random();
    burstData[o + 5] = maxLife;
    burstData[o + 6] = size;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, burstBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, burstData, gl.STATIC_DRAW);

  // ロケット buffer は毎フレーム head 位置を書き換えるので DYNAMIC。
  const rocketData = new Float32Array(ROCKET_POINTS * STRIDE_FLOATS);
  for (let i = 0; i < ROCKET_POINTS; i++) {
    const o = i * STRIDE_FLOATS;
    rocketData[o + 2] = 0; // velocity 0（位置は JS が毎フレーム与える）
    rocketData[o + 3] = 0;
    rocketData[o + 4] = Math.random();
    rocketData[o + 5] = 1; // maxLife（u_time=0 で常に full bright なので無効）
    rocketData[o + 6] = (i === 0 ? 6.0 : 3.4) * scale; // head は太め
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, rocketBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, rocketData, gl.DYNAMIC_DRAW);

  let burstStarted = false;
  let burstStartMs = 0;
  // 前フレームの head 位置（spark の lag に使う）。
  let prevRx = targetX;
  let prevRy = startY;

  const drawFullscreen = (srcTex: WebGLTexture, fade: number, floor: number): void => {
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL の gl.useProgram であって React hook ではない（命名衝突の誤検知）。
    gl.useProgram(quadProgram);
    gl.uniform1i(qTex, 0);
    gl.uniform1f(qFade, fade);
    gl.uniform1f(qFloor, floor);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const drawPoints = (vao: WebGLVertexArrayObject, count: number, timeSec: number): void => {
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL の gl.useProgram であって React hook ではない（命名衝突の誤検知）。
    gl.useProgram(pointProgram);
    gl.uniform2f(pRes, W, H);
    gl.uniform1f(pTime, timeSec);
    gl.uniform1f(pGravity, GRAVITY * scale);
    gl.uniform1f(pTau, DRAG_TAU);
    gl.uniform1f(pBaseHue, baseHue);
    gl.uniform1f(pHueSpread, HUE_SPREAD);
    gl.uniform1f(pSizeMax, sizeMax);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.POINTS, 0, count);
  };

  const updateRocket = (elapsed: number): void => {
    const t = Math.min(1, elapsed / actualRiseMs);
    const ry = startY + (targetY - startY) * easeOutQuad(t);
    const wobble =
      wobbleDir *
      Math.sin(t * Math.PI * 2 * WOBBLE_CYCLES) *
      WOBBLE_AMPLITUDE *
      scale *
      Math.cos((t * Math.PI) / 2);
    const rx = targetX + wobble;
    // head は現在位置、spark は直前位置寄りに少し散らす（trail バッファが尾を作る）。
    for (let i = 0; i < ROCKET_POINTS; i++) {
      const o = i * STRIDE_FLOATS;
      if (i === 0) {
        rocketData[o] = rx;
        rocketData[o + 1] = ry;
      } else {
        const lag = i / ROCKET_POINTS;
        rocketData[o] = rx + (prevRx - rx) * lag + (Math.random() * 2 - 1) * 2 * scale;
        rocketData[o + 1] = ry + (prevRy - ry) * lag + (Math.random() * 2 - 1) * 2 * scale;
      }
    }
    prevRx = rx;
    prevRy = ry;
    gl.bindBuffer(gl.ARRAY_BUFFER, rocketBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, rocketData);
  };

  const renderFrame = (elapsedMs: number): void => {
    if (!targetA || !targetB) return;
    gl.viewport(0, 0, W, H);

    // 1) fade pass: 前フレーム（targetA）を減衰させて targetB へ写す。
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetB.fbo);
    gl.disable(gl.BLEND);
    drawFullscreen(targetA.tex, TRAIL_FADE, TRAIL_FLOOR);

    // 2) 現在の粒を targetB に加算合成。
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    if (elapsedMs < actualRiseMs) {
      updateRocket(elapsedMs);
      drawPoints(rocketVao, ROCKET_POINTS, 0);
    } else {
      if (!burstStarted) {
        burstStarted = true;
        burstStartMs = elapsedMs;
      }
      drawPoints(burstVao, particleCount, (elapsedMs - burstStartMs) / 1000);
    }

    // 3) present: targetB を画面（default framebuffer）へ提示。
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    drawFullscreen(targetB.tex, 1, 0);

    // 4) ping-pong swap。
    const tmp = targetA;
    targetA = targetB;
    targetB = tmp;
  };

  const dispose = (): void => {
    gl.deleteProgram(quadProgram);
    gl.deleteProgram(pointProgram);
    gl.deleteBuffer(burstBuffer);
    gl.deleteBuffer(rocketBuffer);
    gl.deleteVertexArray(burstVao);
    gl.deleteVertexArray(rocketVao);
    gl.deleteVertexArray(emptyVao);
    if (targetA) {
      gl.deleteTexture(targetA.tex);
      gl.deleteFramebuffer(targetA.fbo);
    }
    if (targetB) {
      gl.deleteTexture(targetB.tex);
      gl.deleteFramebuffer(targetB.fbo);
    }
    targetA = null;
    targetB = null;
  };

  return { renderFrame, dispose };
}

export default {
  id: "fireworks",
  type: "effect",
  singleton: true,
  run: async (ctx: EffectContext<FireworksOptions>, options: FireworksOptions): Promise<void> => {
    let rafId: number | null = null;
    let sceneDispose: (() => void) | null = null;

    const handle = ctx.renderer.drawOnGLCanvas((gl) => {
      const scene = setupScene(gl, options);
      if (!scene) return; // GL resource 確保に失敗したら no-op。
      sceneDispose = scene.dispose;

      const startTime = performance.now();
      const tick = (): void => {
        if (ctx.signal.aborted) {
          rafId = null;
          return;
        }
        scene.renderFrame(performance.now() - startTime);
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    });

    // signal abort 時に即 RAF cancel + GL 解放 + canvas 撤去する。
    // singleton: true なので、同 id の新規 dispatch で前の signal が abort される。
    // cleanup は冪等。
    const cleanup = (): void => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (sceneDispose) {
        sceneDispose();
        sceneDispose = null;
      }
      handle.dispose();
    };
    ctx.signal.addEventListener("abort", cleanup, { once: true });

    try {
      // durationMs は「呼び出し側が canvas を保持したい最低時間」の hint。
      // rise + burst fade の自然終了時間を下回る場合は pack 側で延長する。
      await ctx.time.after(Math.max(options.durationMs, MIN_EFFECT_MS));
    } finally {
      ctx.signal.removeEventListener("abort", cleanup);
      cleanup();
    }
  },
} satisfies EffectDefinition<FireworksOptions>;
