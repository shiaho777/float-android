package app.pneuma.app;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 应用更新器：GitHub Releases 的 APK 资产经 OkHttp 原生线程下载到
 * cacheDir/updates/，JS 侧只收节流后的进度事件（不搬字节——70MB 走桥
 * 会反复 GC）。支持 Range 断点续传：暂停=取消请求保留残件，
 * 重进页面拿残件大小作为 offset 继续。
 *
 * 事件（均携带 fileName）：
 *  - updateProgress  received/total/speedBps
 *  - updateDone      path（绝对路径，供 install 使用）
 *  - updateError     message
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build();

    private volatile Call activeCall;
    private volatile boolean paused = false;

    private File updatesDir() {
        File dir = new File(getContext().getCacheDir(), "updates");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url");
        String fileName = call.getString("fileName");
        long offset = call.getInt("offset", 0);
        if (url == null || fileName == null) {
            call.reject("url/fileName required");
            return;
        }
        // 防目录穿越
        if (fileName.contains("/") || fileName.contains("..")) {
            call.reject("bad fileName");
            return;
        }
        if (activeCall != null) {
            call.reject("download already running");
            return;
        }
        paused = false;
        File target = new File(updatesDir(), fileName);
        long existing = target.exists() ? target.length() : 0;
        // offset 以磁盘残件为准——双写不同步时宁可从头来
        final long startAt = Math.min(offset, existing);

        Request.Builder rb = new Request.Builder().url(url);
        if (startAt > 0) rb.header("Range", "bytes=" + startAt + "-");
        activeCall = client.newCall(rb.build());
        call.resolve();

        final long resumeBase = startAt;
        activeCall.enqueue(new okhttp3.Callback() {
            @Override public void onFailure(Call c, IOException e) {
                activeCall = null;
                if (c.isCanceled() || paused) return; // 主动暂停/取消不算错误
                emit("updateError", e.getMessage() != null ? e.getMessage() : "network error", fileName);
            }

            @Override public void onResponse(Call c, Response res) {
                activeCall = null;
                try {
                    if (!res.isSuccessful()) {
                        // 416 = Range 超界：残件可能已完整或损坏，删掉让 JS 决定重下
                        emit("updateError", "HTTP " + res.code(), fileName);
                        res.close();
                        return;
                    }
                    ResponseBody body = res.body();
                    if (body == null) { emit("updateError", "empty body", fileName); res.close(); return; }
                    boolean resumed = res.code() == 206 && resumeBase > 0;
                    long base = resumed ? resumeBase : 0;
                    long total = base + body.contentLength();

                    File out = new File(updatesDir(), fileName);
                    try (InputStream in = body.byteStream();
                         FileOutputStream fos = new FileOutputStream(out, resumed)) {
                        byte[] buf = new byte[64 * 1024];
                        long received = base;
                        long lastEmitMs = 0, lastEmitBytes = base;
                        int n;
                        while ((n = in.read(buf)) != -1) {
                            fos.write(buf, 0, n);
                            received += n;
                            long now = System.currentTimeMillis();
                            if (now - lastEmitMs >= 300) {
                                long speed = (long) ((received - lastEmitBytes) * 1000.0 / Math.max(1, now - lastEmitMs));
                                JSObject p = new JSObject();
                                p.put("received", received);
                                p.put("total", total);
                                p.put("speedBps", Math.max(0, speed));
                                p.put("fileName", fileName);
                                notifyListeners("updateProgress", p);
                                lastEmitMs = now;
                                lastEmitBytes = received;
                            }
                        }
                        fos.flush();
                    }
                    JSObject d = new JSObject();
                    d.put("path", out.getAbsolutePath());
                    d.put("fileName", fileName);
                    notifyListeners("updateDone", d);
                } catch (IOException e) {
                    if (!paused) emit("updateError", e.getMessage() != null ? e.getMessage() : "io error", fileName);
                } finally {
                    res.close();
                }
            }
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        paused = true;
        Call c = activeCall;
        if (c != null) c.cancel();
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        paused = true;
        Call c = activeCall;
        if (c != null) c.cancel();
        String fileName = call.getString("fileName");
        if (fileName != null) {
            File f = new File(updatesDir(), fileName);
            if (f.exists()) f.delete();
        }
        call.resolve();
    }

    /** 残件大小：重进页面时 JS 用它校验断点是否还在。 */
    @PluginMethod
    public void partialSize(PluginCall call) {
        String fileName = call.getString("fileName");
        File f = fileName == null ? null : new File(updatesDir(), fileName);
        JSObject r = new JSObject();
        r.put("size", f != null && f.exists() ? f.length() : 0);
        call.resolve(r);
    }

    /** 触发系统包安装器。需要 REQUEST_INSTALL_PACKAGES + FileProvider。 */
    @PluginMethod
    public void install(PluginCall call) {
        String fileName = call.getString("fileName");
        File f = fileName == null ? null : new File(updatesDir(), fileName);
        if (f == null || !f.exists()) {
            call.reject("apk not found");
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(getContext(),
                    getContext().getPackageName() + ".fileprovider", f);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("install failed: " + e.getMessage());
        }
    }

    private void emit(String event, String message, String fileName) {
        JSObject o = new JSObject();
        o.put("message", message);
        o.put("fileName", fileName);
        notifyListeners(event, o);
    }
}
