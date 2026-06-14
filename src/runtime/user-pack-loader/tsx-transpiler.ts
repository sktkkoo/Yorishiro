/**
 * user pack TSX transpiler.
 *
 * `.tsx` entry を runtime で esbuild-wasm transpile し、React / JSX runtime は
 * host 側の shim に解決する。現在は ui.tsx と scene.tsx がこの経路を使う。
 * Relative imports は pack directory 内の source file に限定して inline bundle する。
 * Persistent `.build` output は follow-up。
 */

import type * as ReactThreeDrei from "@react-three/drei";
import type * as ReactThreeFiber from "@react-three/fiber";
import * as esbuild from "esbuild-wasm";
import esbuildWasmUrl from "esbuild-wasm/esbuild.wasm?url";
import type * as React from "react";
import type * as ReactJsxRuntime from "react/jsx-runtime";
import type * as ReactDomClient from "react-dom/client";
import type * as THREE from "three";
import type * as CharminalControls from "../../sdk/controls";
import type * as CharminalR3f from "../../sdk/r3f";

const HOST_NAMESPACE = "charminal-host";
const USER_SOURCE_NAMESPACE = "charminal-user-source";
const UNSUPPORTED_NAMESPACE = "charminal-unsupported";
const SUPPORTED_HOST_IMPORTS = new Set([
  "@charminal/sdk",
  "@charminal/sdk/controls",
  "@charminal/sdk/r3f",
  "@react-three/drei",
  "@react-three/fiber",
  "react",
  "react-dom/client",
  "react/jsx-runtime",
  "three",
]);

declare global {
  var __CHARMINAL_REACT__: typeof React | undefined;
  var __CHARMINAL_REACT_DOM_CLIENT__: typeof ReactDomClient | undefined;
  var __CHARMINAL_REACT_JSX_RUNTIME__: typeof ReactJsxRuntime | undefined;
  var __CHARMINAL_REACT_THREE_DREI__: typeof ReactThreeDrei | undefined;
  var __CHARMINAL_REACT_THREE_FIBER__: typeof ReactThreeFiber | undefined;
  var __CHARMINAL_THREE__: typeof THREE | undefined;
  var __CHARMINAL_SDK_CONTROLS__: typeof CharminalControls | undefined;
  var __CHARMINAL_SDK_R3F__: typeof CharminalR3f | undefined;
}

export interface TsxTranspilerDeps {
  readonly convertFileSrc: (filePath: string, protocol?: string) => string;
}

export interface TsxTranspilerOptions {
  readonly cacheKey?: string | number;
}

let initializePromise: Promise<void> | null = null;
const RELATIVE_IMPORT_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"] as const;

type SourceLoader = "tsx" | "ts" | "jsx" | "js";

export function isTsxEntryPath(entryPath: string): boolean {
  return entryPath.endsWith(".tsx");
}

export function isSupportedTsxHostImport(path: string): boolean {
  return SUPPORTED_HOST_IMPORTS.has(path);
}

function packDirForEntry(entryPath: string): string {
  return entryPath.slice(0, entryPath.lastIndexOf("/"));
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function normalizePosixPath(path: string): string | null {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const raw of path.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(raw);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

function isWithinPackDir(path: string, packDir: string): boolean {
  return path === packDir || path.startsWith(`${packDir}/`);
}

export function resolveRelativeTsxImport(
  importPath: string,
  importerPath: string,
  packDir: string,
): string | null {
  if (!importPath.startsWith("./") && !importPath.startsWith("../")) {
    return null;
  }
  const baseDir = importerPath === "" ? packDir : dirname(importerPath);
  const normalized = normalizePosixPath(`${baseDir}/${importPath}`);
  if (normalized === null || !isWithinPackDir(normalized, packDir)) {
    return null;
  }
  return normalized;
}

function sourceLoaderForPath(path: string): SourceLoader | null {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".js")) return "js";
  return null;
}

async function readUserSource(
  sourcePath: string,
  deps: TsxTranspilerDeps,
  options: TsxTranspilerOptions,
): Promise<string | null> {
  const url = buildTsxEntryUrl(sourcePath, deps, options);
  const response = await fetch(url, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `failed to read TSX relative import (${response.status} ${response.statusText}) at ${sourcePath}`,
    );
  }
  return response.text();
}

function ensureEsbuildInitialized(): Promise<void> {
  initializePromise ??= esbuild.initialize({
    wasmURL: esbuildWasmUrl,
    worker: true,
  });
  return initializePromise;
}

export function buildTsxEntryUrl(
  entryPath: string,
  deps: TsxTranspilerDeps,
  options: TsxTranspilerOptions = {},
): string {
  const url = deps.convertFileSrc(entryPath);
  if (options.cacheKey === undefined) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${encodeURIComponent(String(options.cacheKey))}`;
}

async function readEntrySource(
  entryPath: string,
  deps: TsxTranspilerDeps,
  options: TsxTranspilerOptions = {},
): Promise<string> {
  const url = buildTsxEntryUrl(entryPath, deps, options);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`failed to read TSX entry (${response.status} ${response.statusText})`);
  }
  return response.text();
}

const reactShim = `
const React = globalThis.__CHARMINAL_REACT__;
if (!React) throw new Error("Charminal React host bridge is not initialized");
export default React;
export const Children = React.Children;
export const Component = React.Component;
export const Fragment = React.Fragment;
export const Profiler = React.Profiler;
export const PureComponent = React.PureComponent;
export const StrictMode = React.StrictMode;
export const Suspense = React.Suspense;
export const cloneElement = React.cloneElement;
export const createContext = React.createContext;
export const createElement = React.createElement;
export const createRef = React.createRef;
export const forwardRef = React.forwardRef;
export const isValidElement = React.isValidElement;
export const lazy = React.lazy;
export const memo = React.memo;
export const startTransition = React.startTransition;
export const useCallback = React.useCallback;
export const useContext = React.useContext;
export const useDebugValue = React.useDebugValue;
export const useDeferredValue = React.useDeferredValue;
export const useEffect = React.useEffect;
export const useId = React.useId;
export const useImperativeHandle = React.useImperativeHandle;
export const useInsertionEffect = React.useInsertionEffect;
export const useLayoutEffect = React.useLayoutEffect;
export const useMemo = React.useMemo;
export const useReducer = React.useReducer;
export const useRef = React.useRef;
export const useState = React.useState;
export const useSyncExternalStore = React.useSyncExternalStore;
export const useTransition = React.useTransition;
`;

const reactDomClientShim = `
const ReactDomClient = globalThis.__CHARMINAL_REACT_DOM_CLIENT__;
if (!ReactDomClient) throw new Error("Charminal React DOM client host bridge is not initialized");
export const createRoot = ReactDomClient.createRoot;
export const hydrateRoot = ReactDomClient.hydrateRoot;
`;

const jsxRuntimeShim = `
const Runtime = globalThis.__CHARMINAL_REACT_JSX_RUNTIME__;
if (!Runtime) throw new Error("Charminal React JSX runtime bridge is not initialized");
export const Fragment = Runtime.Fragment;
export const jsx = Runtime.jsx;
export const jsxs = Runtime.jsxs;
`;

const sdkShim = `
export {};
`;

const r3fShim = `
const Fiber = globalThis.__CHARMINAL_REACT_THREE_FIBER__;
const SdkR3F = globalThis.__CHARMINAL_SDK_R3F__;
if (!Fiber && !SdkR3F) throw new Error("Charminal R3F host bridge is not initialized");
const R3F = { ...(Fiber ?? {}), ...(SdkR3F ?? {}) };
export const {
  Canvas,
  ReactThreeFiber,
  _roots,
  act,
  addAfterEffect,
  addEffect,
  addTail,
  advance,
  applyProps,
  buildGraph,
  context,
  createEvents,
  createPortal,
  createRoot,
  dispose,
  events,
  extend,
  flushGlobalEffects,
  flushSync,
  getRootState,
  invalidate,
  reconciler,
  unmountComponentAtNode,
  useFrame,
  useGraph,
  useInstanceHandle,
  useLoader,
  useStore,
  useThree,
} = R3F;
export default R3F;
`;

const dreiShim = `
const Drei = globalThis.__CHARMINAL_REACT_THREE_DREI__;
if (!Drei) throw new Error("Charminal drei host bridge is not initialized");
export const { AccumulativeShadows, AdaptiveDpr, AdaptiveEvents, ArcballControls, AsciiRenderer, BBAnchor, Backdrop, BakeShadows, Billboard, Bounds, Box, Bvh, CameraControls, CameraShake, Capsule, CatmullRomLine, Caustics, Center, Circle, Clone, Cloud, CloudInstance, Clouds, ComputedAttribute, Cone, ContactShadows, CubeCamera, CubeTexture, CubicBezierLine, CurveModifier, CycleRaycast, Cylinder, Decal, Detailed, DetectGPU, DeviceOrientationControls, Dodecahedron, DragControls, Edges, Effects, Environment, EnvironmentCube, EnvironmentMap, EnvironmentPortal, Example, Extrude, FaceControls, FaceLandmarker, FaceLandmarkerDefaults, Facemesh, FacemeshDatas, FacemeshEye, FacemeshEyeDefaults, Fbo, Fbx, FirstPersonControls, Fisheye, Float, FlyControls, GizmoHelper, GizmoViewcube, GizmoViewport, Gltf, GradientTexture, GradientType, Grid, Helper, Html, Hud, Icosahedron, Image, Instance, InstancedAttribute, Instances, IsObject, KeyboardControls, Ktx2, Lathe, Lightformer, Line, Loader, MapControls, MarchingCube, MarchingCubes, MarchingPlane, Mask, MatcapTexture, Merged, MeshDiscardMaterial, MeshDistortMaterial, MeshPortalMaterial, MeshReflectorMaterial, MeshRefractionMaterial, MeshTransmissionMaterial, MeshWobbleMaterial, MotionPathControls, MultiMaterial, NormalTexture, Octahedron, OrbitControls, OrthographicCamera, Outlines, PerformanceMonitor, PerspectiveCamera, PivotControls, Plane, Point, PointMaterial, PointMaterialImpl, PointerLockControls, Points, PointsBuffer, Polyhedron, PositionMesh, PositionPoint, PositionalAudio, Preload, PresentationControls, Progress, QuadraticBezierLine, RandomizedLight, RenderCubeTexture, RenderTexture, Resize, Ring, RoundedBox, RoundedBoxGeometry, Sampler, ScreenQuad, ScreenSizer, ScreenSpace, ScreenVideoTexture, Scroll, ScrollControls, Segment, SegmentObject, Segments, Select, Shadow, ShadowAlpha, Shape, Sky, SoftShadows, Sparkles, Sphere, Splat, SpotLight, SpotLightShadow, SpriteAnimator, Stage, Stars, Stats, StatsGl, Svg, Tetrahedron, Text, Text3D, Texture, Torus, TorusKnot, TrackballControls, Trail, TrailTexture, TransformControls, Tube, VideoTexture, View, WebcamVideoTexture, Wireframe, accumulativeContext, calcPosFromAngles, calculateScaleFactor, checkIfFrameIsEmpty, createInstances, getFirstFrame, isWebGL2Available, meshBounds, shaderMaterial, useAnimations, useAspect, useBVH, useBounds, useBoxProjectedEnv, useCamera, useContextBridge, useCubeCamera, useCubeTexture, useCursor, useDepthBuffer, useDetectGPU, useEnvironment, useFBO, useFBX, useFaceControls, useFaceLandmarker, useFont, useGLTF, useGizmoContext, useHelper, useIntersect, useKTX2, useKeyboardControls, useMask, useMatcapTexture, useMotion, useNormalTexture, usePerformanceMonitor, useProgress, useScroll, useSelect, useSpriteAnimator, useSpriteLoader, useSurfaceSampler, useTexture, useTrail, useTrailTexture, useVideoTexture } = Drei;
export default Drei;
`;

const controlsShim = `
const Controls = globalThis.__CHARMINAL_SDK_CONTROLS__;
if (!Controls) throw new Error("Charminal controls host bridge is not initialized");
export const {
  ControlStoreProvider,
  controlFolder,
  useCharminalControls,
  useControlsBridge,
} = Controls;
`;

const threeShim = `
const THREE = globalThis.__CHARMINAL_THREE__;
if (!THREE) throw new Error("Charminal Three.js host bridge is not initialized");
export const { ACESFilmicToneMapping, AddEquation, AddOperation, AdditiveAnimationBlendMode, AdditiveBlending, AgXToneMapping, AlphaFormat, AlwaysCompare, AlwaysDepth, AlwaysStencilFunc, AmbientLight, AnimationAction, AnimationClip, AnimationLoader, AnimationMixer, AnimationObjectGroup, AnimationUtils, ArcCurve, ArrayCamera, ArrowHelper, AttachedBindMode, Audio, AudioAnalyser, AudioContext, AudioListener, AudioLoader, AxesHelper, BackSide, BasicDepthPacking, BasicShadowMap, BatchedMesh, BezierInterpolant, Bone, BooleanKeyframeTrack, Box2, Box3, Box3Helper, BoxGeometry, BoxHelper, BufferAttribute, BufferGeometry, BufferGeometryLoader, ByteType, Cache, Camera, CameraHelper, CanvasTexture, CapsuleGeometry, CatmullRomCurve3, CineonToneMapping, CircleGeometry, ClampToEdgeWrapping, Clock, Color, ColorKeyframeTrack, ColorManagement, Compatibility, CompressedArrayTexture, CompressedCubeTexture, CompressedTexture, CompressedTextureLoader, ConeGeometry, ConstantAlphaFactor, ConstantColorFactor, Controls, CubeCamera, CubeDepthTexture, CubeReflectionMapping, CubeRefractionMapping, CubeTexture, CubeTextureLoader, CubeUVReflectionMapping, CubicBezierCurve, CubicBezierCurve3, CubicInterpolant, CullFaceBack, CullFaceFront, CullFaceFrontBack, CullFaceNone, Curve, CurvePath, CustomBlending, CustomToneMapping, CylinderGeometry, Cylindrical, Data3DTexture, DataArrayTexture, DataTexture, DataTextureLoader, DataUtils, DecrementStencilOp, DecrementWrapStencilOp, DefaultLoadingManager, DepthFormat, DepthStencilFormat, DepthTexture, DetachedBindMode, DirectionalLight, DirectionalLightHelper, DiscreteInterpolant, DodecahedronGeometry, DoubleSide, DstAlphaFactor, DstColorFactor, DynamicCopyUsage, DynamicDrawUsage, DynamicReadUsage, EdgesGeometry, EllipseCurve, EqualCompare, EqualDepth, EqualStencilFunc, EquirectangularReflectionMapping, EquirectangularRefractionMapping, Euler, EventDispatcher, ExternalTexture, ExtrudeGeometry, FileLoader, Float16BufferAttribute, Float32BufferAttribute, FloatType, Fog, FogExp2, FramebufferTexture, FrontSide, Frustum, FrustumArray, GLBufferAttribute, GLSL1, GLSL3, GreaterCompare, GreaterDepth, GreaterEqualCompare, GreaterEqualDepth, GreaterEqualStencilFunc, GreaterStencilFunc, GridHelper, Group, HalfFloatType, HemisphereLight, HemisphereLightHelper, IcosahedronGeometry, ImageBitmapLoader, ImageLoader, ImageUtils, IncrementStencilOp, IncrementWrapStencilOp, InstancedBufferAttribute, InstancedBufferGeometry, InstancedInterleavedBuffer, InstancedMesh, Int16BufferAttribute, Int32BufferAttribute, Int8BufferAttribute, IntType, InterleavedBuffer, InterleavedBufferAttribute, Interpolant, InterpolateBezier, InterpolateDiscrete, InterpolateLinear, InterpolateSmooth, InterpolationSamplingMode, InterpolationSamplingType, InvertStencilOp, KeepStencilOp, KeyframeTrack, LOD, LatheGeometry, Layers, LessCompare, LessDepth, LessEqualCompare, LessEqualDepth, LessEqualStencilFunc, LessStencilFunc, Light, LightProbe, Line, Line3, LineBasicMaterial, LineCurve, LineCurve3, LineDashedMaterial, LineLoop, LineSegments, LinearFilter, LinearInterpolant, LinearMipMapLinearFilter, LinearMipMapNearestFilter, LinearMipmapLinearFilter, LinearMipmapNearestFilter, LinearSRGBColorSpace, LinearToneMapping, LinearTransfer, Loader, LoaderUtils, LoadingManager, LoopOnce, LoopPingPong, LoopRepeat, MOUSE, Material, MaterialBlending, MaterialLoader, MathUtils, Matrix2, Matrix3, Matrix4, MaxEquation, Mesh, MeshBasicMaterial, MeshDepthMaterial, MeshDistanceMaterial, MeshLambertMaterial, MeshMatcapMaterial, MeshNormalMaterial, MeshPhongMaterial, MeshPhysicalMaterial, MeshStandardMaterial, MeshToonMaterial, MinEquation, MirroredRepeatWrapping, MixOperation, MultiplyBlending, MultiplyOperation, NearestFilter, NearestMipMapLinearFilter, NearestMipMapNearestFilter, NearestMipmapLinearFilter, NearestMipmapNearestFilter, NeutralToneMapping, NeverCompare, NeverDepth, NeverStencilFunc, NoBlending, NoColorSpace, NoNormalPacking, NoToneMapping, NormalAnimationBlendMode, NormalBlending, NormalGAPacking, NormalRGPacking, NotEqualCompare, NotEqualDepth, NotEqualStencilFunc, NumberKeyframeTrack, Object3D, ObjectLoader, ObjectSpaceNormalMap, OctahedronGeometry, OneFactor, OneMinusConstantAlphaFactor, OneMinusConstantColorFactor, OneMinusDstAlphaFactor, OneMinusDstColorFactor, OneMinusSrcAlphaFactor, OneMinusSrcColorFactor, OrthographicCamera, PCFShadowMap, PCFSoftShadowMap, PMREMGenerator, Path, PerspectiveCamera, Plane, PlaneGeometry, PlaneHelper, PointLight, PointLightHelper, Points, PointsMaterial, PolarGridHelper, PolyhedronGeometry, PositionalAudio, PropertyBinding, PropertyMixer, QuadraticBezierCurve, QuadraticBezierCurve3, Quaternion, QuaternionKeyframeTrack, QuaternionLinearInterpolant, R11_EAC_Format, RED_GREEN_RGTC2_Format, RED_RGTC1_Format, REVISION, RG11_EAC_Format, RGBADepthPacking, RGBAFormat, RGBAIntegerFormat, RGBA_ASTC_10x10_Format, RGBA_ASTC_10x5_Format, RGBA_ASTC_10x6_Format, RGBA_ASTC_10x8_Format, RGBA_ASTC_12x10_Format, RGBA_ASTC_12x12_Format, RGBA_ASTC_4x4_Format, RGBA_ASTC_5x4_Format, RGBA_ASTC_5x5_Format, RGBA_ASTC_6x5_Format, RGBA_ASTC_6x6_Format, RGBA_ASTC_8x5_Format, RGBA_ASTC_8x6_Format, RGBA_ASTC_8x8_Format, RGBA_BPTC_Format, RGBA_ETC2_EAC_Format, RGBA_PVRTC_2BPPV1_Format, RGBA_PVRTC_4BPPV1_Format, RGBA_S3TC_DXT1_Format, RGBA_S3TC_DXT3_Format, RGBA_S3TC_DXT5_Format, RGBDepthPacking, RGBFormat, RGBIntegerFormat, RGB_BPTC_SIGNED_Format, RGB_BPTC_UNSIGNED_Format, RGB_ETC1_Format, RGB_ETC2_Format, RGB_PVRTC_2BPPV1_Format, RGB_PVRTC_4BPPV1_Format, RGB_S3TC_DXT1_Format, RGDepthPacking, RGFormat, RGIntegerFormat, RawShaderMaterial, Ray, Raycaster, RectAreaLight, RedFormat, RedIntegerFormat, ReinhardToneMapping, RenderTarget, RenderTarget3D, RepeatWrapping, ReplaceStencilOp, ReverseSubtractEquation, RingGeometry, SIGNED_R11_EAC_Format, SIGNED_RED_GREEN_RGTC2_Format, SIGNED_RED_RGTC1_Format, SIGNED_RG11_EAC_Format, SRGBColorSpace, SRGBTransfer, Scene, ShaderChunk, ShaderLib, ShaderMaterial, ShadowMaterial, Shape, ShapeGeometry, ShapePath, ShapeUtils, ShortType, Skeleton, SkeletonHelper, SkinnedMesh, Source, Sphere, SphereGeometry, Spherical, SphericalHarmonics3, SplineCurve, SpotLight, SpotLightHelper, Sprite, SpriteMaterial, SrcAlphaFactor, SrcAlphaSaturateFactor, SrcColorFactor, StaticCopyUsage, StaticDrawUsage, StaticReadUsage, StereoCamera, StreamCopyUsage, StreamDrawUsage, StreamReadUsage, StringKeyframeTrack, SubtractEquation, SubtractiveBlending, TOUCH, TangentSpaceNormalMap, TetrahedronGeometry, Texture, TextureLoader, TextureUtils, Timer, TimestampQuery, TorusGeometry, TorusKnotGeometry, Triangle, TriangleFanDrawMode, TriangleStripDrawMode, TrianglesDrawMode, TubeGeometry, UVMapping, Uint16BufferAttribute, Uint32BufferAttribute, Uint8BufferAttribute, Uint8ClampedBufferAttribute, Uniform, UniformsGroup, UniformsLib, UniformsUtils, UnsignedByteType, UnsignedInt101111Type, UnsignedInt248Type, UnsignedInt5999Type, UnsignedIntType, UnsignedShort4444Type, UnsignedShort5551Type, UnsignedShortType, VSMShadowMap, Vector2, Vector3, Vector4, VectorKeyframeTrack, VideoFrameTexture, VideoTexture, WebGL3DRenderTarget, WebGLArrayRenderTarget, WebGLCoordinateSystem, WebGLCubeRenderTarget, WebGLRenderTarget, WebGLRenderer, WebGLUtils, WebGPUCoordinateSystem, WebXRController, WireframeGeometry, WrapAroundEnding, ZeroCurvatureEnding, ZeroFactor, ZeroSlopeEnding, ZeroStencilOp, createCanvasElement, error, getConsoleFunction, log, setConsoleFunction, warn, warnOnce } = THREE;
export default THREE;
`;

function extractNamedExports(shim: string): string[] {
  const names = new Set<string>();
  const matches = shim.matchAll(/export const \{([\s\S]*?)\} = /g);
  for (const match of matches) {
    for (const name of match[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)) {
      names.add(name);
    }
  }
  return Array.from(names).sort();
}

export function tsxHostShimNamedExports(path: string): readonly string[] {
  if (path === "@react-three/drei") return extractNamedExports(dreiShim);
  if (path === "@charminal/sdk/r3f" || path === "@react-three/fiber") {
    return extractNamedExports(r3fShim);
  }
  if (path === "@charminal/sdk/controls") return extractNamedExports(controlsShim);
  if (path === "three") return extractNamedExports(threeShim);
  return [];
}

function createPlan4MvpPlugin(
  packDir: string,
  deps: TsxTranspilerDeps,
  options: TsxTranspilerOptions,
): esbuild.Plugin {
  return {
    name: "charminal-ui-pack-plan4-mvp",
    setup(build) {
      build.onResolve(
        {
          filter: /.*/,
        },
        (args) =>
          isSupportedTsxHostImport(args.path)
            ? {
                path: args.path,
                namespace: HOST_NAMESPACE,
              }
            : undefined,
      );
      build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
        const resolved = resolveRelativeTsxImport(args.path, args.importer, packDir);
        if (resolved === null) {
          return {
            path: args.path,
            namespace: UNSUPPORTED_NAMESPACE,
            pluginData: `relative import '${args.path}' escapes the pack directory`,
          };
        }
        return {
          path: resolved,
          namespace: USER_SOURCE_NAMESPACE,
          resolveDir: dirname(resolved),
        };
      });
      build.onResolve({ filter: /.*/ }, (args) => ({
        path: args.path,
        namespace: UNSUPPORTED_NAMESPACE,
        pluginData: `unsupported import '${args.path}' in runtime-transpiled .tsx entry`,
      }));
      build.onLoad({ filter: /.*/, namespace: HOST_NAMESPACE }, (args) => {
        if (args.path === "react") {
          return { contents: reactShim, loader: "js" };
        }
        if (args.path === "react/jsx-runtime") {
          return { contents: jsxRuntimeShim, loader: "js" };
        }
        if (args.path === "react-dom/client") {
          return { contents: reactDomClientShim, loader: "js" };
        }
        if (args.path === "@react-three/drei") {
          return { contents: dreiShim, loader: "js" };
        }
        if (args.path === "@charminal/sdk/r3f" || args.path === "@react-three/fiber") {
          return { contents: r3fShim, loader: "js" };
        }
        if (args.path === "@charminal/sdk/controls") {
          return { contents: controlsShim, loader: "js" };
        }
        if (args.path === "three") {
          return { contents: threeShim, loader: "js" };
        }
        return { contents: sdkShim, loader: "js" };
      });
      build.onLoad({ filter: /.*/, namespace: USER_SOURCE_NAMESPACE }, async (args) => {
        const candidates =
          sourceLoaderForPath(args.path) === null
            ? RELATIVE_IMPORT_EXTENSIONS.map((ext) => `${args.path}${ext}`)
            : [args.path];
        for (const sourcePath of candidates) {
          const loader = sourceLoaderForPath(sourcePath);
          if (loader === null) continue;
          const contents = await readUserSource(sourcePath, deps, options);
          if (contents !== null) {
            return {
              contents,
              loader,
              resolveDir: dirname(sourcePath),
            };
          }
        }
        return {
          errors: [
            {
              text: `relative import '${args.path}' not found; expected one of ${candidates.join(", ")}`,
            },
          ],
        };
      });
      build.onLoad({ filter: /.*/, namespace: UNSUPPORTED_NAMESPACE }, (args) => ({
        errors: [{ text: String(args.pluginData) }],
      }));
    },
  };
}

export async function transpileUiTsxEntry(
  entryPath: string,
  deps: TsxTranspilerDeps,
  options: TsxTranspilerOptions = {},
): Promise<string> {
  await ensureEsbuildInitialized();
  const source = await readEntrySource(entryPath, deps, options);
  const packDir = packDirForEntry(entryPath);
  const result = await esbuild.build({
    bundle: true,
    format: "esm",
    jsx: "automatic",
    logLevel: "silent",
    platform: "browser",
    stdin: {
      contents: source,
      loader: "tsx",
      resolveDir: packDir,
      sourcefile: entryPath,
    },
    target: "es2020",
    treeShaking: true,
    write: false,
    plugins: [createPlan4MvpPlugin(packDir, deps, options)],
  });
  const output = result.outputFiles?.[0]?.text;
  if (output === undefined) {
    throw new Error("esbuild-wasm produced no output");
  }
  return output;
}

export async function importUiTsxEntry(
  entryPath: string,
  deps: TsxTranspilerDeps,
  options: TsxTranspilerOptions = {},
): Promise<unknown> {
  const code = await transpileUiTsxEntry(entryPath, deps, options);
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
