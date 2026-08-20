import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "../web/src"),
      "next/navigation": resolve(__dirname, "src/next-navigation.ts"),
    },
    dedupe: ["react", "react-dom"],
  },
  define: {
    "process.env.NEXT_PUBLIC_ZANO_LOCAL_MODE": JSON.stringify("true"),
    "process.env.NEXT_PUBLIC_ZANO_DESKTOP": JSON.stringify("true"),
    "process.env.NEXT_PUBLIC_ZANO_LOCAL_SERVER_URL": JSON.stringify(
      "http://127.0.0.1:8787",
    ),
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    fs: {
      allow: [resolve(__dirname, "..")],
    },
  },
  build: {
    target: ["es2022", "chrome105", "safari13"],
  },
});
