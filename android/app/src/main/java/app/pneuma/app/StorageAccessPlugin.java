package app.pneuma.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 公共 Documents 目录写入权限桥：Android 11+ 裸路径写共享存储需要
 * MANAGE_EXTERNAL_STORAGE（所有文件访问），它不在普通运行时权限体系里，
 * 只能弹系统设置页让用户手动开。低版本（<R）无需该权限，直接放行。
 */
@CapacitorPlugin(name = "StorageAccess")
public class StorageAccessPlugin extends Plugin {

    @PluginMethod
    public void checkManageAccess(PluginCall call) {
        JSObject out = new JSObject();
        out.put("granted", hasManageAccess());
        call.resolve(out);
    }

    @PluginMethod
    public void requestManageAccess(PluginCall call) {
        if (!hasManageAccess() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(intent);
            } catch (Exception e) {
                // 个别 ROM 没有按应用直达页，退回全局列表页
                try {
                    getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                } catch (Exception ignored) { }
            }
        }
        JSObject out = new JSObject();
        out.put("granted", hasManageAccess());
        call.resolve(out);
    }

    private boolean hasManageAccess() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.R
                || Environment.isExternalStorageManager();
    }
}
