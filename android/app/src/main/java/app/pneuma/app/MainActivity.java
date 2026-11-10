package app.pneuma.app;

import android.os.Bundle;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

    /** 渲染进程刚被系统杀掉时正在 reload。第二次再死就停，避免 OOM 循环把页面刷死。 */
    private boolean rendererRecovering;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 麦克风/相机权限不在启动时申请——由 MediaPermissionsPlugin
        // 在对应功能（语音输入/视频通话/自定义 App 录音）被使用时按需拉起。
        registerPlugin(MediaPermissionsPlugin.class);
        // 生成保活：长时间 LLM/生图请求期间拉起前台服务，退后台不被挂起
        registerPlugin(GenerationKeepAlivePlugin.class);
        // 原生 HTTP：LLM 等长连接/流式请求由 OkHttp 承载，绕开 WebView fetch
        registerPlugin(NativeHttpPlugin.class);
        // 原生媒体存储：图片/音视频字节落文件系统，显示走 _capacitor_file_ 不占 JS 堆
        registerPlugin(NativeMediaPlugin.class);
        // 公共 Documents 写入权限桥：MANAGE_EXTERNAL_STORAGE 只能弹设置页引导
        registerPlugin(StorageAccessPlugin.class);
        // 应用自更新：GitHub Release APK 原生下载（断点续传）+ 拉起系统安装器
        registerPlugin(AppUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
        // 免疫系统字体缩放：WebView textZoom 会跟随系统 FONT_SCALE，
        // 大字体会把这台「虚拟手机」的整版 UI 文字放大打乱布局。
        // 应用内有自己的文字缩放设置，不需要系统层再叠一层。
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().getSettings().setTextZoom(100);
        }
        // 生成把 WebView 渲染进程撑死后，系统默认是留下一块白屏。
        // 返回 true 表示应用自己处理；页面重新载入后这次生成会丢掉，但手机还能用。
        if (getBridge() != null) {
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public void onPageLoaded(WebView webView) {
                    rendererRecovering = false;
                }

                @Override
                public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                    Log.e("MainActivity", "webview renderer gone, recovering=" + rendererRecovering);
                    if (webView == null || rendererRecovering) return true;
                    rendererRecovering = true;
                    webView.post(() -> {
                        try {
                            webView.reload();
                        } catch (RuntimeException error) {
                            Log.e("MainActivity", "webview reload after renderer loss failed", error);
                        }
                    });
                    return true;
                }
            });
        }
    }
}
