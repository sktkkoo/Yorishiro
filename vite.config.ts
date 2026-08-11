import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  base: "./",
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**"],
  },
  resolve: {
    alias: [
      {
        find: /^@yorishiro\/sdk\/controls$/,
        replacement: new URL("./src/sdk/controls.ts", import.meta.url).pathname,
      },
      {
        find: /^@yorishiro\/sdk\/r3f$/,
        replacement: new URL("./src/sdk/r3f.ts", import.meta.url).pathname,
      },
      {
        find: /^leva$/,
        replacement: new URL("./src/runtime/leva.tsx", import.meta.url).pathname,
      },
    ],
    // Scene packs and the custom R3F host must always resolve the same module
    // instances. This is especially important in dev, where Vite can otherwise
    // keep an older optimized dependency generation alive across HMR updates.
    dedupe: [
      "react",
      "react-dom",
      "@react-three/fiber",
      "@react-three/postprocessing",
      "postprocessing",
      "three",
    ],
  },

  // Discover the complete R3F graph before the WebView starts. A late
  // postprocessing discovery can trigger dependency re-optimization while the
  // hot-preserved ThreeRuntime still holds hooks from the previous generation.
  optimizeDeps: {
    include: [
      "@react-three/fiber",
      "@react-three/drei",
      "@react-three/postprocessing",
      "postprocessing",
    ],
  },

  build: {
    chunkSizeWarningLimit: 2500,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
