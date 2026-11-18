import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false, // 共享测试库，串行执行避免数据互踩
    // next build（output: standalone）会把源码镜像进 .next/standalone，
    // 里面的 tests 副本会被默认 glob 扫进来当"失败文件"，显式排除
    exclude: ["**/node_modules/**", ".next/**"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
