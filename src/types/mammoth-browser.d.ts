// mammoth 浏览器端用的是预构建 UMD bundle（lib 入口引 node 依赖，浏览器跑不了），
// 该子路径无官方类型，这里按实际用到的 API 声明；完整类型从主入口 "mammoth" 借用。
declare module "mammoth/mammoth.browser" {
  const mammoth: typeof import("mammoth");
  export default mammoth;
}
