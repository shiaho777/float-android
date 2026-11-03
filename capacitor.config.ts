import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.floatphone.app",
  appName: "Pneuma",
  webDir: "out",
  // https scheme:让 WebView 里的请求保持 secure context(IndexedDB/ crypto / SW 行为与网页版一致),
  // 同时 fetch 第三方 API 的 origin 是 https://localhost,主流 LLM 端点的 CORS 均放行。
  android: {
    // 用户常配 http:// 局域网端点（Ollama/自建代理等）；
    // https://localhost 页面访问 http:// 资源需要放行 mixed content，
    // 配合 manifest 的 usesCleartextTraffic 才生效。
    allowMixedContent: true,
  },
  server: {
    androidScheme: "https",
  },
};

export default config;
