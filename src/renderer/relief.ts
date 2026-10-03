/**
 * 浮雕：用深度图在一层里面做逐像素视差。
 *
 * CSS 那边每一层是整块平移的（见 card.css 的 .hc__plane），层内是平的，主体像一张剪纸立在卡里。
 * 这里把一层画到 WebGL 画布上，近处多挪、远处少挪，鼻尖和耳朵错开，主体才像真的从卡面凸出来（issue #29）。
 *
 * 做法是网格：把这一层铺成 GRID×GRID 的网格，顶点按它那里的深度往指针反方向推，图片贴在网格上跟着走。
 * 试过逐像素反查（片元着色器里迭代求「这个像素原来在哪」），深度陡变处（头发和脸的交界）会折叠，
 * 画面被横着撕开。网格在陡变处只是拉伸，重叠的地方开深度测试，近的盖住远的，遮挡关系也对。
 *
 * 每一层都做，和整层视差是同一个深度场：一个深度为 d 的像素在屏幕上挪 c·(d − 焦平面深度)，
 * c 是 manifest 里「每单位深度多少视差」（见 reliefLayers）。整层平移（CSS）已经挪了这一层代表深度的那一份，
 * 这里只补「这个像素的深度 − 这一层的代表深度」那一份，所以层内起伏和层间跳变接得上，不再是两套各调各的位移。
 * 以前只做主体层、轮廓钉在区间远端：层内和层间单位不一样，调大假、调小看不出。
 *
 * 每层的顶点深度只认这一层自己那段深度（见 layerGrid）：深度图是整张图的，背景层被主体挡住的那块
 * 在深度图里是主体的深度，主体层轮廓外是背景的深度。区间外的顶点用邻居扩散补，
 * 而不是在着色器里钳到区间边上——钳出来是一圈平台，轮廓边上一道硬折。
 *
 * 只负责「层内比整层多挪多少」这一项，整层的平移还是 CSS 做，两者方向一致、叠加。
 * 箔面也还是 CSS：画布替换的只是 .hc__art 那张图。
 * 不支持 WebGL、上下文丢了，调用方退回原来的 <img>。
 */

/**
 * 靠边多宽的一圈里位移逐渐收到 0（占卡片宽高的比例），见顶点着色器。
 * 6 格（64 格网格的 6/64）：远景的层内位移在倾斜到头时约 4% 卡宽，摊到这么宽里，拉伸不到一倍，看不出来
 */
const EDGE = 6 / 64;

const VERTEX = `
#define EDGE ${EDGE.toFixed(6)}
attribute vec2 a_uv;
attribute float a_depth;
uniform vec2 u_shift;
uniform float u_ref;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  float depth = a_depth;
  // 靠边的顶点在垂直于边的方向上逐渐收住，到边上为 0：不然一挪，卡片边缘就露出一条透明缝
  //（CSS 的放大补偿只算了整层平移，管不到这里多出来的位移）。
  // 以前只钉最外一圈，多出来的位移全挤在最后一格里，卡边拉出一道明显的拖影；摊到靠边几格里就看不出
  vec2 free = smoothstep(0.0, EDGE, a_uv) * smoothstep(0.0, EDGE, 1.0 - a_uv);
  // 纹理坐标 → 裁剪空间（y 朝上），再按深度差平移。z 取近为小，配合默认的 LESS 深度测试
  vec2 pos = a_uv + u_shift * (depth - u_ref) * free;
  gl_Position = vec4(pos.x * 2.0 - 1.0, 1.0 - pos.y * 2.0, 0.5 - depth * 0.5, 1.0);
}`;

const FRAGMENT = `
precision mediump float;
uniform sampler2D u_art;
varying vec2 v_uv;
void main() {
  vec4 color = texture2D(u_art, v_uv);
  // 透明处不写深度：不然这一层里透明的那片会把它背后（同一层里更远的）画面挡出窟窿
  if (color.a < 0.01) discard;
  gl_FragColor = color;
}`;

/**
 * 网格每边多少格。顶点上的深度从深度图缩到这个尺寸采样，缩小本身就是一次平滑：
 * 格子越密，深度陡变处拉伸得越窄越尖锐；越疏越柔和但细节少。64 在卡片尺寸上看不出折线
 */
const GRID = 64;
/** 画布最长边的上限。层图可能有三四千像素，按屏幕尺寸画就够，再大只是费显存 */
const MAX_SIDE = 2048;
/**
 * 画布按设备像素比建，但封顶 2。三倍屏的 iPhone 上画布面积是两倍屏的 2.25 倍，
 * 肉眼几乎看不出差别，显存却大一倍多；显存吃得越多，切后台时 WebGL 越容易被系统收走
 */
const MAX_DPR = 2;
type GL = WebGLRenderingContext | WebGL2RenderingContext;

/** 一层在深度上的位置：ref 是参考深度（不额外挪的深度，即整层平移对应的深度），[lo, hi] 是这一层自己的深度区间（见 layerGrid） */
export interface ReliefLayer {
  ref: number;
  lo: number;
  hi: number;
}

/**
 * 由 manifest 的各层（由远及近）推出每层的深度区间、参考深度，以及 perDepth：每单位深度多少视差。
 *
 * 视差是 segmenter 的 toParallax 由深度推出来的：视差相同的相邻层是一组（刚性边界连着），
 * 组的代表深度取组内各层深度的均值，再线性归一到 0..1。这里按同样的分组反推回去：
 * perDepth = 视差跨度 / 组深度跨度，每层的参考深度 = 它那一组的代表深度——
 * 整层平移挪的正好是「代表深度」那一份，浮雕补上像素深度和它的差，合起来每个像素挪 perDepth·(d − 焦平面深度)。
 * 整张图是一个刚体（视差全相同）时 perDepth 是 0：不做视差就也不做浮雕。
 *
 * 区间：相邻两层之间取中点当分界。真正的切点在 manifest 里没有存（只在 generator 标签里），中点离它不远
 */
export function reliefLayers(layers: readonly { depth: number; parallax: number }[]): {
  layers: ReliefLayer[];
  perDepth: number;
} {
  const groups: { parallax: number; depth: number; count: number }[] = [];
  const groupOf = layers.map((layer) => {
    const last = groups[groups.length - 1];
    if (last && last.parallax === layer.parallax) {
      last.depth += layer.depth;
      last.count++;
    } else {
      groups.push({ parallax: layer.parallax, depth: layer.depth, count: 1 });
    }
    return groups.length - 1;
  });
  const mean = groups.map((g) => g.depth / g.count);
  const first = groups[0];
  const last = groups[groups.length - 1];
  const span = (mean[mean.length - 1] ?? 0) - (mean[0] ?? 0);
  const perDepth = first && last && Math.abs(span) > 1e-6 ? (last.parallax - first.parallax) / span : 0;
  const depths = layers.map((layer) => layer.depth);
  return {
    perDepth,
    layers: depths.map((depth, i) => {
      const prev = depths[i - 1];
      const next = depths[i + 1];
      return {
        ref: mean[groupOf[i] ?? 0] ?? depth,
        lo: prev === undefined ? 0 : (prev + depth) / 2,
        hi: next === undefined ? 1 : (depth + next) / 2,
      };
    }),
  };
}

export class Relief {
  readonly canvas: HTMLCanvasElement;
  readonly #gl: GL;
  readonly #shift: WebGLUniformLocation | null;
  readonly #ref: WebGLUniformLocation | null;
  readonly #count: number;
  #lost = false;
  #destroyed = false;

  /**
   * 建不起来（没有 WebGL、着色器编译失败）就抛错，调用方保持原来的 <img>。
   * capture：要被截图（分享图、导出动图）时传 true，见 preserveDrawingBuffer。
   * displayWidth 是画布在屏幕上的 CSS 宽度（含 plane 的放大），按它乘设备像素比定画布尺寸，
   * 正对着时画布像素和屏幕像素一比一——大了小了都要被浏览器再缩放一次，画面发软；
   * depth 是这一层自己的顶点深度（见 layerGrid）
   */
  constructor(
    art: HTMLImageElement,
    depth: Float32Array,
    displayWidth: number,
    capture: boolean,
    onLost: () => void,
  ) {
    const canvas = document.createElement('canvas');
    /*
     * 画布尺寸按屏幕上实际显示的像素来，而不是层图原尺寸：WebGL1 里非 2 的幂的纹理没有 mipmap，
     * 大图缩小采样会出摩尔纹，转动时画面闪。先用 2D 画布把图缩到画布尺寸（浏览器的缩放质量好），再传给 WebGL。
     * ponytail: 尺寸只在建的时候定一次，之后窗口变大会略糊，要严格的话监听尺寸变化重建
     */
    const ratio = art.naturalHeight / art.naturalWidth;
    const want = Math.max(1, Math.round(displayWidth * Math.min(window.devicePixelRatio || 1, MAX_DPR)));
    const width = Math.min(art.naturalWidth, want, Math.round(MAX_SIDE / Math.max(1, ratio)), MAX_SIDE);
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, Math.round(width * ratio));

    /*
     * 不开多重采样：轮廓是靠纹理 alpha 加 discard 出来的，多重采样本来就抹不平这种边，白占三四倍显存。
     * preserveDrawingBuffer 只在要截图时开（服务端截分享图、导出动图要读得到上一次画的内容），平时每帧多一次拷贝
     */
    const attributes: WebGLContextAttributes = {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: true,
      preserveDrawingBuffer: capture,
    };
    // 优先 WebGL2：非 2 的幂的纹理也能做 mipmap，网格压缩处缩小采样不闪。着色器两边通用
    const gl: GL | null = canvas.getContext('webgl2', attributes) ?? canvas.getContext('webgl', attributes);
    if (!gl) throw new Error('没有 WebGL');
    const mipmaps = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

    const program = link(gl, VERTEX, FRAGMENT);
    gl.useProgram(program);

    // 顶点：(GRID+1)² 个，每个带纹理坐标和深度；三角形按格子两两拼
    const side = GRID + 1;
    const uv = new Float32Array(side * side * 2);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        uv[(y * side + x) * 2] = x / GRID;
        uv[(y * side + x) * 2 + 1] = y / GRID;
      }
    }
    const indices = new Uint16Array(GRID * GRID * 6);
    let k = 0;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const i = y * side + x;
        indices.set([i, i + 1, i + side, i + 1, i + side + 1, i + side], k);
        k += 6;
      }
    }
    attribute(gl, program, 'a_uv', uv, 2);
    attribute(gl, program, 'a_depth', depth, 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.#count = indices.length;

    // 预乘 alpha 再上传：半透明的边缘做双线性插值时才不会混出一圈黑边
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    /*
     * 纹理和画布一样大：正对着时一个纹素对一个像素，最清楚。
     * 试过给到画布的两倍，网格稍微一压缩就会混进低一级的 mipmap，倾斜时整片发软。
     * WebGL2 再加 mipmap，网格被压缩得厉害的地方不闪；WebGL1 里非 2 的幂的纹理做不了 mipmap
     */
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, resized(art, canvas.width, canvas.height));
    if (mipmaps) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.uniform1i(gl.getUniformLocation(program, 'u_art'), 0);
    this.#shift = gl.getUniformLocation(program, 'u_shift');
    this.#ref = gl.getUniformLocation(program, 'u_ref');

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);

    // 切后台、内存紧张时系统会收走 WebGL 上下文。收走了就整块不要了，由调用方退回 <img>、回到前台再重建。
    // destroy() 自己调 loseContext 也会触发这个事件，而且是排进任务里晚到的，那时这块画布已经不归调用方管了
    canvas.addEventListener('webglcontextlost', () => {
      this.#lost = true;
      if (!this.#destroyed) onLost();
    });

    this.canvas = canvas;
    this.#gl = gl;
  }

  /**
   * shift：每单位深度差位移多少（纹理坐标，x、y 各自按宽、高）；
   * ref：这一层的参考深度（不额外挪的那个深度）
   */
  draw(shiftX: number, shiftY: number, ref: number): void {
    if (this.#lost) return;
    const gl = this.#gl;
    gl.uniform2f(this.#shift, shiftX, shiftY);
    gl.uniform1f(this.#ref, ref);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, this.#count, gl.UNSIGNED_SHORT, 0);
  }

  /** 立刻还掉 GPU 资源。浏览器同时能开的 WebGL 上下文有限（十几个），换卡时不还很快就会顶到上限 */
  destroy(): void {
    this.#destroyed = true;
    this.#gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }
}

/** 整张图的深度（0..1，越大越近），按深度图原尺寸 */
export interface DepthMap {
  data: Float32Array;
  width: number;
  height: number;
}

export function readDepth(image: HTMLImageElement): DepthMap {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('读不了深度图');
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = (pixels[i * 4] ?? 0) / 255;
  return { data, width, height };
}

/** 区间外的顶点补完之后再磨几轮，补出来的那片和区间内的接成一张平滑的面 */
const SMOOTH_ROUNDS = 40;

/**
 * 一层网格顶点上的深度：每个顶点取它那一格里落在 [lo, hi] 内的像素的平均；
 * 一个都不落在区间里的顶点先由已知的邻居一圈圈往外长，再只在这些补出来的顶点上反复取邻居平均（拉普拉斯平滑），
 * 已知的顶点不动。整层都没有区间内的像素（不该发生）就全填 fallback
 */
export function layerGrid(depth: DepthMap, lo: number, hi: number, fallback: number): Float32Array {
  const side = GRID + 1;
  const out = new Float32Array(side * side);
  const known = new Uint8Array(side * side);
  const { data, width, height } = depth;
  let any = false;
  for (let gy = 0; gy < side; gy++) {
    const y0 = Math.max(0, Math.floor(((gy - 0.5) / GRID) * height));
    const y1 = Math.min(height, Math.max(y0 + 1, Math.ceil(((gy + 0.5) / GRID) * height)));
    for (let gx = 0; gx < side; gx++) {
      const x0 = Math.max(0, Math.floor(((gx - 0.5) / GRID) * width));
      const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil(((gx + 0.5) / GRID) * width)));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const d = data[y * width + x] ?? 0;
          if (d >= lo && d <= hi) {
            sum += d;
            n++;
          }
        }
      }
      if (n > 0) {
        out[gy * side + gx] = sum / n;
        known[gy * side + gx] = 1;
        any = true;
      }
    }
  }
  if (!any) return out.fill(fallback);

  const neighbors = (i: number): number[] => {
    const x = i % side;
    const list: number[] = [];
    if (x > 0) list.push(i - 1);
    if (x < side - 1) list.push(i + 1);
    if (i >= side) list.push(i - side);
    if (i < side * (side - 1)) list.push(i + side);
    return list;
  };
  // 往外长：每轮只用上一轮已经有值的邻居，不会一轮里顺着扫描方向一路拖过去
  const filled = known.slice();
  for (let grew = true; grew; ) {
    grew = false;
    const next = filled.slice();
    for (let i = 0; i < out.length; i++) {
      if (filled[i]) continue;
      let sum = 0;
      let n = 0;
      for (const j of neighbors(i)) {
        if (filled[j]) {
          sum += out[j] ?? 0;
          n++;
        }
      }
      if (n > 0) {
        out[i] = sum / n;
        next[i] = 1;
        grew = true;
      }
    }
    filled.set(next);
  }
  for (let round = 0; round < SMOOTH_ROUNDS; round++) {
    const prev = out.slice();
    for (let i = 0; i < out.length; i++) {
      if (known[i]) continue;
      const list = neighbors(i);
      let sum = 0;
      for (const j of list) sum += prev[j] ?? 0;
      out[i] = sum / list.length;
    }
  }
  return out;
}

function attribute(
  gl: GL,
  program: WebGLProgram,
  name: string,
  data: Float32Array,
  size: number,
): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const location = gl.getAttribLocation(program, name);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
}

function compile(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('建不了着色器');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`着色器编译失败：${gl.getShaderInfoLog(shader) ?? ''}`);
  }
  return shader;
}

function link(gl: GL, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('建不了着色器程序');
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`着色器链接失败：${gl.getProgramInfoLog(program) ?? ''}`);
  }
  return program;
}

/** 用 2D 画布把图缩到目标尺寸。本来就不比目标大就原样返回 */
function resized(image: HTMLImageElement, width: number, height: number): TexImageSource {
  if (image.naturalWidth <= width) return image;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return image;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);
  return canvas;
}
