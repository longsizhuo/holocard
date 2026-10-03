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
 * 只负责「层内比整层多挪多少」这一项，整层的平移还是 CSS 做，两者方向一致、叠加。
 * 箔面也还是 CSS：画布替换的只是 .hc__art 那张图。
 * 不支持 WebGL、上下文丢了，调用方退回原来的 <img>。
 */

const VERTEX = `
attribute vec2 a_uv;
attribute float a_depth;
uniform vec2 u_shift;
uniform float u_ref;
// 这一层自己的深度区间。深度图是整张图的：背景层被主体挡住的那块（补全出来的）在深度图里是主体的深度，
// 主体层轮廓外透明的那片是背景的深度。不钳的话，背景藏在主体身后的部分被当成近处推开，
// 主体的网格从轮廓一路拉到外面那片远处，头发边上就被扯出一圈
uniform vec2 u_band;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  float depth = clamp(a_depth, u_band.x, u_band.y);
  // 最外圈的顶点在垂直于边的方向上钉住：不然一挪，卡片边缘就露出一条透明缝
  //（CSS 的放大补偿只算了整层平移，管不到这里多出来的位移）
  vec2 free = step(0.001, a_uv) * step(a_uv, vec2(0.999));
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
type GL = WebGLRenderingContext | WebGL2RenderingContext;

/** 一层在深度上的位置：ref 是参考深度，[lo, hi] 是这一层自己的深度区间（见顶点着色器的 u_band） */
export interface ReliefLayer {
  ref: number;
  lo: number;
  hi: number;
}

/**
 * 由各层的代表深度（由远及近）推出每层的深度区间：相邻两层之间取中点当分界。
 * 真正的切点在 manifest 里没有存（只在 generator 标签里），中点离它不远；
 * 主体层是抠出来的、深度被往前提过（见 segmenter），中点也还是落在两层之间
 */
export function reliefLayers(depths: readonly number[]): ReliefLayer[] {
  return depths.map((ref, i) => {
    const prev = depths[i - 1];
    const next = depths[i + 1];
    const lo = prev === undefined ? 0 : (prev + ref) / 2;
    const hi = next === undefined ? 1 : (ref + next) / 2;
    return { ref: Math.min(Math.max(ref, lo), hi), lo, hi };
  });
}

export class Relief {
  readonly canvas: HTMLCanvasElement;
  readonly #gl: GL;
  readonly #shift: WebGLUniformLocation | null;
  readonly #ref: WebGLUniformLocation | null;
  readonly #band: WebGLUniformLocation | null;
  readonly #count: number;
  #lost = false;

  /**
   * 建不起来（没有 WebGL、着色器编译失败）就抛错，调用方保持原来的 <img>。
   * displayWidth 是画布在屏幕上的 CSS 宽度（含 plane 的放大），按它乘设备像素比定画布尺寸，
   * 正对着时画布像素和屏幕像素一比一——大了小了都要被浏览器再缩放一次，画面发软；
   * depth 是整张图的深度网格（见 sampleDepth），几层共用一份
   */
  constructor(art: HTMLImageElement, depth: Float32Array, displayWidth: number, onLost: () => void) {
    const canvas = document.createElement('canvas');
    /*
     * 画布尺寸按屏幕上实际显示的像素来，而不是层图原尺寸：WebGL1 里非 2 的幂的纹理没有 mipmap，
     * 大图缩小采样会出摩尔纹，转动时画面闪。先用 2D 画布把图缩到画布尺寸（浏览器的缩放质量好），再传给 WebGL。
     * ponytail: 尺寸只在建的时候定一次，之后窗口变大会略糊，要严格的话监听尺寸变化重建
     */
    const ratio = art.naturalHeight / art.naturalWidth;
    const want = Math.max(1, Math.round(displayWidth * (window.devicePixelRatio || 1)));
    const width = Math.min(art.naturalWidth, want, Math.round(MAX_SIDE / Math.max(1, ratio)), MAX_SIDE);
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, Math.round(width * ratio));

    // preserveDrawingBuffer：服务端截分享图、导出动图时要读得到上一次画的内容
    const attributes: WebGLContextAttributes = {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      depth: true,
      preserveDrawingBuffer: true,
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
    this.#band = gl.getUniformLocation(program, 'u_band');

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);

    canvas.addEventListener('webglcontextlost', () => {
      this.#lost = true;
      onLost();
    });

    this.canvas = canvas;
    this.#gl = gl;
  }

  /**
   * shift：每单位深度差位移多少（纹理坐标，x、y 各自按宽、高）；
   * layer：这一层的参考深度（不额外挪的那个深度）和它自己的深度区间
   */
  draw(shiftX: number, shiftY: number, layer: ReliefLayer): void {
    if (this.#lost) return;
    const gl = this.#gl;
    gl.uniform2f(this.#shift, shiftX, shiftY);
    gl.uniform1f(this.#ref, layer.ref);
    gl.uniform2f(this.#band, layer.lo, layer.hi);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, this.#count, gl.UNSIGNED_SHORT, 0);
  }

  /** 立刻还掉 GPU 资源。浏览器同时能开的 WebGL 上下文有限（十几个），换卡时不还很快就会顶到上限 */
  destroy(): void {
    this.#gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }
}

/**
 * 把深度图采样成网格顶点上的深度（0..1，越大越近）。
 * 用 2D 画布缩到 (GRID+1)² 再读像素：浏览器缩小时会做平均，正好把深度图里的锯齿和噪点抹掉
 */
export function sampleDepth(depth: HTMLImageElement): Float32Array {
  const side = GRID + 1;
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('读不了深度图');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(depth, 0, 0, side, side);
  const pixels = ctx.getImageData(0, 0, side, side).data;
  const out = new Float32Array(side * side);
  for (let i = 0; i < out.length; i++) out[i] = (pixels[i * 4] ?? 0) / 255;
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
