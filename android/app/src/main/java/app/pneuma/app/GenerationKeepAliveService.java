package app.pneuma.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * 前台服务 + 部分唤醒锁 + WiFi 锁：长时间生成任务（查手机/栖所/生图/聊天回复）
 * 进行中时，防止 App 退到桌面/锁屏后被系统挂起进程或掐断网络。
 * WebView 本身 KeepRunning=true 不会被暂停，缺的只是进程优先级。
 * 生命周期由 JS 侧 lib/keep-alive.ts 以引用计数驱动。
 */
public class GenerationKeepAliveService extends Service {

    public static final String EXTRA_LABEL = "label";
    private static final String TAG = "GenerationKeepAlive";

    private static final String CHANNEL_ID = "generation_keepalive";
    private static final int NOTIFICATION_ID = 4701;

    /** 兜底时长：JS 侧异常退出没来得及 stop 时，避免服务/唤醒锁无限滞留耗电 */
    private static final long FAILSAFE_MS = 30L * 60 * 1000;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable failsafeStop = this::stopSelf;

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pneuma:generation");
                wakeLock.setReferenceCounted(false);
            }
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                int mode = Build.VERSION.SDK_INT >= 29
                        ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                        : WifiManager.WIFI_MODE_FULL;
                wifiLock = wm.createWifiLock(mode, "pneuma:generation");
                wifiLock.setReferenceCounted(false);
            }
        } catch (RuntimeException error) {
            // 锁拿不到就只保前台服务。这里抛出去会在生成开始的瞬间把进程打死，页面留下白屏。
            Log.e(TAG, "keep-alive locks unavailable", error);
            wakeLock = null;
            wifiLock = null;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            createChannel();
            String label = intent != null ? intent.getStringExtra(EXTRA_LABEL) : null;
            Notification notification = buildNotification(label);
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(FAILSAFE_MS);
            if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
            // 双保险：即使唤醒锁超时自动释放了，服务本身也别一直挂着
            handler.removeCallbacks(failsafeStop);
            handler.postDelayed(failsafeStop, FAILSAFE_MS + 60_000);
            return START_NOT_STICKY;
        } catch (RuntimeException error) {
            // startForeground / 唤醒锁失败时必须自己停掉，否则系统会因前台服务没起来而杀进程。
            Log.e(TAG, "keep-alive foreground start failed", error);
            stopSelf();
            return START_NOT_STICKY;
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "后台生成", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("生成内容（查手机/栖所等）进行期间保持后台联网");
        channel.setShowBadge(false);
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(channel);
    }

    private Notification buildNotification(String label) {
        Intent launch = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
                this, 0, launch,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String text = label != null && !label.isEmpty() ? label : "正在生成内容…";
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(text)
                .setContentIntent(pending)
                .setOngoing(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .build();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(failsafeStop);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        try {
            stopForeground(true);
        } catch (RuntimeException error) {
            Log.e(TAG, "stopForeground failed", error);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
