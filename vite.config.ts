import { cp, copyFile } from "node:fs/promises";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function copyData(): Plugin {
  return {
    name: "copy-static-artifacts",
    async closeBundle() {
      await cp(path.resolve("data"), path.resolve("dist/data"), {
        recursive: true,
      });
      await copyFile(path.resolve("dist/index.html"), path.resolve("dist/404.html"));
    },
  };
}

export default defineConfig({
  base: "/Clawbook/",
  plugins: [react(), copyData()],
});
