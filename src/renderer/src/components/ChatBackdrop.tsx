import { useEffect, useRef } from 'react'
import { activeTheme, clampStrength, THEME_PATTERNS, type ChatTheme } from '@shared/chat-themes'
import { useEvent } from '@/lib/api'
import { useApp } from '@/lib/store'

/*
 * The chat's animated background (Settings › Chat › Background). Flow and waves are adapted from 21st.dev
 * Shader Builder recipes ("Flow field", "Waves"); mesh, swirl and halftone take their look from 21st.dev's
 * community shaders (Stripe-like gradient, Swirl, Blue halftone). No pointer effects: one WebGL canvas,
 * four colours and a few dials per theme. It sits under the conversation, dimmed by the theme's strength.
 */

const VERT = 'attribute vec2 a_position;void main(){gl_Position=vec4(a_position,0.0,1.0);}'

const FRAG = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec3 u_colors[4];
uniform vec4 u_scene;   // resolution.xy, time, pattern (0 flow, 1 waves, 2 mesh, 3 swirl, 4 halftone)
uniform vec4 u_shape;   // scale, intensity, drift, blur
uniform vec4 u_finish;  // grain, vignette, brightness, unused

float hash21(vec2 p){p=fract(p*vec2(234.34,435.345));p+=dot(p,p+34.23);return fract(p.x*p.y);}
float grainHash(vec2 p){vec3 p3=fract(vec3(p.xyx)*0.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash21(i),hash21(i+vec2(1.0,0.0)),u.x),mix(hash21(i+vec2(0.0,1.0)),hash21(i+vec2(1.0,1.0)),u.x),u.y);}
float fbm(vec2 p){float v=0.0;float a=0.5;for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.03+vec2(17.0,9.2);a*=0.5;}return v;}
vec3 palette(float x){float f=clamp(x,0.0,1.0)*3.0;vec3 c=u_colors[0];
  c=mix(c,u_colors[1],smoothstep(0.0,1.0,clamp(f,0.0,1.0)));
  c=mix(c,u_colors[2],smoothstep(0.0,1.0,clamp(f-1.0,0.0,1.0)));
  return mix(c,u_colors[3],smoothstep(0.0,1.0,clamp(f-2.0,0.0,1.0)));}

// Ordered (Bayer) dither threshold, 0..1, for a pixel cell.
float bayer2(vec2 a){a=floor(a);return fract(dot(a,vec2(0.5,a.y*0.75)));}
float bayer4(vec2 a){return bayer2(0.5*a)*0.25+bayer2(a);}

// px: this sample's pixel position, for the patterns drawn on a pixel grid (swirl's dither, halftone's dots).
vec3 shade(vec2 uv,vec2 p,float t,vec2 px){
  float k=u_scene.w;
  if(k<0.5){
    float a=fbm(p*2.0+7.0)*6.2831;
    vec2 dir=vec2(cos(a),sin(a));
    return palette(fbm(p*3.0+dir*(u_shape.y*2.0)+t*0.12));
  }
  if(k<1.5){
    float y=uv.y+sin(uv.x*(3.0+u_shape.y*9.0)+t*0.8)*0.08+(fbm(p*2.0+t*0.1)-0.5)*u_shape.y*0.6;
    return palette(y);
  }
  if(k<2.5){
    // Mesh: four colour blobs drifting over a dark gradient and blending where they meet.
    vec2 m=p+(vec2(fbm(p+t*0.05),fbm(p+vec2(4.1,7.3)-t*0.04))-0.5)*u_shape.y*1.6;
    vec3 col=mix(u_colors[0],u_colors[1],0.15+0.35*uv.y);
    for(int i=0;i<4;i++){
      float fi=float(i);
      vec2 c=vec2(sin(t*0.13*(fi+1.0)+fi*1.7),cos(t*0.11*(fi+1.3)+fi*2.3))*0.6*u_shape.x;
      vec2 d=m-c;
      col=mix(col,palette(0.45+0.18*fi),0.9*exp(-dot(d,d)*4.0/u_shape.x));
    }
    return col;
  }
  if(k<3.5){
    // Swirl: spiral arms that tighten towards the centre, in four dithered steps.
    float rad=length(p);
    float ang=atan(p.y,p.x);
    float twist=ang+u_shape.y*2.5/(rad+0.35)-t*0.25;
    float v=0.5+0.5*sin(3.0*twist+rad*6.0-t*0.6+(fbm(p*2.0+t*0.1)-0.5)*3.0*u_shape.y);
    v*=smoothstep(1.6,0.2,rad*0.6);
    float level=floor(v*3.0+bayer4(px/2.0))/3.0;
    return palette(clamp(level,0.0,1.0)*0.92);
  }
  // Halftone: a dot screen at 28 degrees, each dot sized by a slow field sampled at its centre.
  mat2 rot=mat2(0.883,-0.469,0.469,0.883);
  float cell=max(7.0,min(u_scene.x,u_scene.y)/55.0);
  vec2 g=rot*px/cell;
  vec2 c=floor(g)+0.5;
  vec2 pc=p+((c-g)*cell*rot)/min(u_scene.x,u_scene.y)*u_shape.x;
  float v=smoothstep(0.3,0.75,fbm(pc*1.4+t*0.08+u_shape.y*fbm(pc*3.0-t*0.05)));
  float d=length(g-c);
  float aa=1.2/cell;
  float spot=1.0-smoothstep(0.5*sqrt(v)-aa,0.5*sqrt(v)+aa,d);
  return mix(palette(v*0.3),palette(0.45+0.55*v),spot);
}

void main(){
  vec2 res=u_scene.xy;float t=u_scene.z;
  vec2 screenUv=gl_FragCoord.xy/res;
  vec2 p=(gl_FragCoord.xy-0.5*res)/min(res.x,res.y);
  vec2 uv=p*min(res.x,res.y)/res+0.5;
  p*=u_shape.x;
  if(abs(u_scene.w-1.0)<0.5){float r=4.5029;p=mat2(cos(r),-sin(r),sin(r),cos(r))*p;p+=vec2(0.16,0.05);
    p+=0.126*(vec2(fbm(p*3.296+7.0),fbm(p*3.296+vec2(5.2,1.3)))-0.5);}
  p+=u_shape.z*vec2(sin(t*0.31),cos(t*0.23));
  vec3 col;
  float e=u_shape.w;
  vec2 px=gl_FragCoord.xy;
  if(e>0.0){float pe=e*u_shape.x;vec2 uvE=vec2(e)*min(res.x,res.y)/res;float pxE=e*min(res.x,res.y);
    col=shade(uv,p,t,px)*0.36+shade(uv+vec2(uvE.x,0.0),p+vec2(pe,0.0),t,px+vec2(pxE,0.0))*0.16+shade(uv-vec2(uvE.x,0.0),p-vec2(pe,0.0),t,px-vec2(pxE,0.0))*0.16
      +shade(uv+vec2(0.0,uvE.y),p+vec2(0.0,pe),t,px+vec2(0.0,pxE))*0.16+shade(uv-vec2(0.0,uvE.y),p-vec2(0.0,pe),t,px-vec2(0.0,pxE))*0.16;
  } else col=shade(uv,p,t,px);
  col=(col-0.5)*0.924+0.5;
  col+=u_finish.z;
  float vd=length(screenUv-0.5)*1.41421356;
  col*=1.0-u_finish.y*smoothstep(0.35,1.0,vd);
  col+=(grainHash(gl_FragCoord.xy+vec2(119.0,217.0))-0.5)*u_finish.x;
  gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);
}`

const hexToRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
const FRAME_MS = 1000 / 30
/** Contexts are let go a moment after unmounting, so a remount straight after (React's dev double run) keeps its context. */
const pendingRelease = new WeakMap<HTMLCanvasElement, number>()

/** The chat's background, from the theme in Settings (nothing when it's off or WebGL isn't there). */
export function ChatBackdrop() {
  const settings = useApp((s) => s.settings)
  const loadSettings = useApp((s) => s.loadSettings)
  // The chat agent's chat_theme tool (or another window) changed it.
  useEvent('themes', () => void loadSettings())
  const theme = settings ? activeTheme(settings.chatTheme, settings.chatThemes) : null
  if (!theme) return null
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <ShaderCanvas theme={theme} />
      <div className="absolute inset-0 bg-bg" style={{ opacity: 1 - clampStrength(settings?.chatThemeStrength) }} />
    </div>
  )
}

function ShaderCanvas({ theme }: { theme: ChatTheme }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const themeRef = useRef(theme)
  themeRef.current = theme
  const redraw = useRef<() => void>(() => undefined)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const pending = pendingRelease.get(canvas)
    if (pending !== undefined) window.clearTimeout(pending)
    pendingRelease.delete(canvas)
    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false })
    if (!gl) return
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      return s
    }
    const program = gl.createProgram()!
    const vs = compile(gl.VERTEX_SHADER, VERT)
    const fs = compile(gl.FRAGMENT_SHADER, FRAG)
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return
    gl.useProgram(program)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(program, 'a_position')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    const u = {
      colors: gl.getUniformLocation(program, 'u_colors'),
      scene: gl.getUniformLocation(program, 'u_scene'),
      shape: gl.getUniformLocation(program, 'u_shape'),
      finish: gl.getUniformLocation(program, 'u_finish')
    }

    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let raf = 0
    let last = 0
    let disposed = false
    // Animation time moves with each theme's speed, so changing it doesn't jump.
    let time = 0
    let prevNow: number | null = null

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      const w0 = Math.max(1, Math.round(rect.width * dpr))
      const h0 = Math.max(1, Math.round(rect.height * dpr))
      // At most ~1.2 megapixels: it's a soft background, and this keeps it light on the GPU.
      const k = Math.min(1, Math.sqrt(1_200_000 / (w0 * h0)))
      const w = Math.max(1, Math.round(w0 * k))
      const h = Math.max(1, Math.round(h0 * k))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        gl.viewport(0, 0, w, h)
      }
    }
    const draw = () => {
      const t = themeRef.current
      resize()
      gl.uniform3fv(u.colors, new Float32Array(t.colors.flatMap(hexToRgb)))
      gl.uniform4f(u.scene, canvas.width, canvas.height, time, Math.max(0, THEME_PATTERNS.indexOf(t.pattern)))
      gl.uniform4f(u.shape, t.scale, t.intensity, t.drift, t.blur)
      gl.uniform4f(u.finish, t.grain, t.vignette, t.brightness, 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    const animated = () => !still?.matches && themeRef.current.speed > 0 && document.visibilityState === 'visible'
    const frame = (now: number) => {
      raf = 0
      if (disposed) return
      if (prevNow !== null) time += (Math.min(now - prevNow, 100) / 1000) * themeRef.current.speed
      prevNow = now
      if (now - last >= FRAME_MS - 1) {
        last = now
        draw()
      }
      if (animated()) raf = requestAnimationFrame(frame)
      else prevNow = null
    }
    const kick = () => {
      if (disposed) return
      if (animated()) {
        if (!raf) raf = requestAnimationFrame(frame)
      } else draw()
    }
    redraw.current = kick
    const ro = new ResizeObserver(kick)
    ro.observe(canvas)
    document.addEventListener('visibilitychange', kick)
    still?.addEventListener?.('change', kick)
    kick()
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      document.removeEventListener('visibilitychange', kick)
      still?.removeEventListener?.('change', kick)
      gl.deleteBuffer(buf)
      gl.deleteProgram(program)
      const timer = window.setTimeout(() => {
        if (pendingRelease.get(canvas) !== timer) return
        pendingRelease.delete(canvas)
        gl.getExtension('WEBGL_lose_context')?.loseContext()
      }, 0)
      pendingRelease.set(canvas, timer)
    }
  }, [])

  // A new or adjusted theme shows at once, even when the background is still.
  useEffect(() => redraw.current(), [theme])

  return <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
}
