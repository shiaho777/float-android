package app.pneuma.app;

import android.Manifest;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 媒体权限按需申请：不在启动时弹窗，语音输入/视频通话/自定义 App 录音
 * 调用 getUserMedia 之前由 JS 主动触发这里，授权结果回传后再继续。
 */
@CapacitorPlugin(
        name = "MediaPermissions",
        permissions = {
                @Permission(strings = {Manifest.permission.RECORD_AUDIO}, alias = "microphone"),
                @Permission(strings = {Manifest.permission.CAMERA}, alias = "camera")
        }
)
public class MediaPermissionsPlugin extends Plugin {

    @PluginMethod
    public void ensureMicrophone(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            call.resolve(result(true));
            return;
        }
        requestPermissionForAlias("microphone", call, "micCallback");
    }

    @PluginMethod
    public void ensureCamera(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            call.resolve(result(true));
            return;
        }
        requestPermissionForAlias("camera", call, "cameraCallback");
    }

    @PluginMethod
    public void ensureCameraAndMic(PluginCall call) {
        boolean micOk = getPermissionState("microphone") == PermissionState.GRANTED;
        boolean camOk = getPermissionState("camera") == PermissionState.GRANTED;
        if (micOk && camOk) {
            call.resolve(result(true));
            return;
        }
        // 一次弹窗把缺的权限一起申请
        if (!micOk && !camOk) {
            requestPermissionForAliases(new String[]{"microphone", "camera"}, call, "avCallback");
        } else if (!micOk) {
            requestPermissionForAlias("microphone", call, "avCallback");
        } else {
            requestPermissionForAlias("camera", call, "avCallback");
        }
    }

    @PermissionCallback
    private void micCallback(PluginCall call) {
        call.resolve(result(getPermissionState("microphone") == PermissionState.GRANTED));
    }

    @PermissionCallback
    private void cameraCallback(PluginCall call) {
        call.resolve(result(getPermissionState("camera") == PermissionState.GRANTED));
    }

    @PermissionCallback
    private void avCallback(PluginCall call) {
        boolean micOk = getPermissionState("microphone") == PermissionState.GRANTED;
        boolean camOk = getPermissionState("camera") == PermissionState.GRANTED;
        call.resolve(result(micOk && camOk));
    }

    private JSObject result(boolean granted) {
        JSObject out = new JSObject();
        out.put("granted", granted);
        return out;
    }
}
