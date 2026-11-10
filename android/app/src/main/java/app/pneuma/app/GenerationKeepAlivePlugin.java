package app.pneuma.app;

import android.content.Intent;

import androidx.core.content.ContextCompat;

import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 生成保活开关：JS（lib/keep-alive.ts）在长时间请求开始/结束时调用。
 * 只负责把启停请求转发给 GenerationKeepAliveService；
 * 后台启动被系统拒绝时静默降级为不保活，不影响业务请求本身。
 */
@CapacitorPlugin(name = "GenerationKeepAlive")
public class GenerationKeepAlivePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        Intent intent = new Intent(getContext(), GenerationKeepAliveService.class);
        String label = call.getString("label");
        if (label != null && !label.isEmpty()) {
            intent.putExtra(GenerationKeepAliveService.EXTRA_LABEL, label);
        }
        try {
            ContextCompat.startForegroundService(getContext(), intent);
        } catch (RuntimeException e) {
            // Android 12+ 禁止后台启动前台服务：此刻 App 已退后台，降级不保活
            Logger.warn("GenerationKeepAlive start rejected: " + e.getMessage());
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), GenerationKeepAliveService.class));
        } catch (RuntimeException e) {
            Logger.warn("GenerationKeepAlive stop failed: " + e.getMessage());
        }
        call.resolve();
    }
}
