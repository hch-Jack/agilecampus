import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 生产 Docker 镜像用 standalone 产物（.next/standalone + server.js），见 Dockerfile
  output: "standalone",
  // 把工作区根钉死在项目目录。不设的话 Next 会从项目目录一路往上找 lockfile，
  // 找到项目之外的任何一个（开发机上主目录里就有一个）就把那层当工作区根：
  // 于是 Turbopack 的主目录整个进入监视与解析范围、构建时刷 workspace root 警告，
  // 且 standalone 产物会按那个根铺进嵌套目录（启动器为此写过一段「摊平」逻辑）。
  // Docker / CI 里项目目录本来就是推断出来的根，所以这行不改那边任何行为。
  turbopack: {
    root: __dirname,
  },
  // 文档生成库自带动态 require（pptxgenjs 找 jszip、docx 找 xml 序列化），
  // 交给 Node 直接 require，别掺进 Turbopack 的打包图
  serverExternalPackages: ["docx", "pptxgenjs"],
  // PDF 的中文字体在运行时用 fs 读，不在模块图里；standalone 产物要显式带上这两份
  outputFileTracingIncludes: {
    "/api/chat": [
      "./node_modules/@embedpdf/fonts-sc/fonts/NotoSansHans-Regular.otf",
      "./node_modules/@embedpdf/fonts-sc/fonts/NotoSansHans-Bold.otf",
    ],
  },
  // 附件上传走 server action：默认 1MB 不够，放开到 12mb（附件上限 10MB + multipart 开销余量）
  experimental: {
    serverActions: {
      bodySizeLimit: "12mb",
    },
  },
};

export default nextConfig;
