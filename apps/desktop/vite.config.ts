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
    "process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_MODE": JSON.stringify("true"),
    "process.env.NEXT_PUBLIC_TEAMMATE_DESKTOP": JSON.stringify("true"),
    "process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_SERVER_URL": JSON.stringify(
      process.env.TEAMMATE_LOCAL_SERVER_URL || "http://127.0.0.1:8787",
    ),
    "process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_CONTROLLER_TOKEN": JSON.stringify(
      process.env.TEAMMATE_LOCAL_CONTROLLER_TOKEN || "",
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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (
            /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:react|react-dom|scheduler)\//.test(id)
          ) {
            return "react-vendor";
          }
          if (id.includes("@base-ui") || id.includes("lucide-react")) return "ui-vendor";
          if (id.includes("@tiptap") || id.includes("prosemirror")) return "editor-vendor";
          if (
            id.includes("react-markdown") ||
            id.includes("remark-") ||
            id.includes("unified") ||
            id.includes("micromark") ||
            id.includes("hast-util") ||
            id.includes("mdast-util")
          ) {
            return "markdown-vendor";
          }
          return "vendor";
        },
      },
    },
  },
});
