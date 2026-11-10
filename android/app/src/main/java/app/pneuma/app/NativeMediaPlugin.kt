package app.pneuma.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.util.Base64
import android.util.Base64InputStream
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * 原生媒体文件存储：媒体字节落 filesDir/media/{id}.{ext}，JS 只持有
 * media-store://id 引用。显示路径经 _capacitor_file_ 让 WebView 直接
 * 从磁盘读，bytes 不进 JS 堆；需要字节的路径（vision 载荷/备份导出）
 * 才走 readBase64。
 *
 * 大图在 resolve 时懒生成 ≤1600px WebP 缩略图（gif/webp/svg 跳过——
 * 前者可能是动图，后者位图工具不认）。元数据不落库：mime/类别/时间
 * 全部由扩展名和文件 mtime 推导，目录本身即索引。
 */
@CapacitorPlugin(name = "NativeMedia")
class NativeMediaPlugin : Plugin() {

    private val io = Executors.newSingleThreadExecutor()
    private val mediaDir: File by lazy { File(context.filesDir, "media").apply { mkdirs() } }
    private val thumbDir: File by lazy { File(context.filesDir, "media-thumb").apply { mkdirs() } }

    private fun extForMime(mime: String?): String =
        when (mime?.substringBefore(';')?.trim()?.lowercase()) {
            "image/png" -> "png"
            "image/jpeg", "image/jpg" -> "jpg"
            "image/gif" -> "gif"
            "image/webp" -> "webp"
            "image/svg+xml" -> "svg"
            "audio/mpeg" -> "mp3"
            "audio/ogg" -> "ogg"
            "audio/flac" -> "flac"
            "audio/wav", "audio/x-wav" -> "wav"
            "audio/mp4", "audio/aac", "audio/x-m4a", "audio/m4a" -> "m4a"
            "video/mp4" -> "mp4"
            "video/webm" -> "webm"
            "application/pdf" -> "pdf"
            else -> "bin"
        }

    /** 按 id 找媒体文件（扩展名任意）；id 白名单校验防路径穿越 */
    private fun fileForId(id: String): File? {
        if (!id.matches(Regex("[A-Za-z0-9_-]+"))) return null
        return mediaDir.listFiles { f -> f.name.substringBeforeLast('.') == id }?.firstOrNull()
    }

    private fun thumbForId(id: String): File =
        File(thumbDir, "$id.webp")

    @PluginMethod
    fun store(call: PluginCall) {
        val dedupe = call.getBoolean("dedupe") == true
        var id = call.getString("id")
        val base64 = call.getString("base64")
        if (!dedupe && (id.isNullOrEmpty() || !id.matches(Regex("[A-Za-z0-9_-]+")))) {
            call.reject("id required")
            return
        }
        if (base64 == null) {
            call.reject("base64 required")
            return
        }
        val mime = call.getString("mime")
        io.execute {
            try {
                // dedupe：字节内容决定 id（mc_<sha256>），相同内容命中既有文件直接复用，
                // 不再重复落盘。JS 侧只需传 base64，hash 在这里算，不回传字节。
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                var existed = false
                if (dedupe) {
                    val hex = MessageDigest.getInstance("SHA-256")
                        .digest(bytes)
                        .joinToString("") { "%02x".format(it) }
                    id = "mc_$hex"
                    existed = fileForId(id!!) != null
                }
                if (!existed) {
                    val file = File(mediaDir, "$id.${extForMime(mime)}")
                    file.outputStream().use { out -> out.write(bytes) }
                    // 同名旧扩展名残留（换格式重写）顺手清掉
                    mediaDir.listFiles { f ->
                        f.name.substringBeforeLast('.') == id && f != file
                    }?.forEach { it.delete() }
                }
                val result = JSObject()
                result.put("id", id)
                result.put("bytes", bytes.size)
                result.put("existed", existed)
                call.resolve(result)
            } catch (e: Exception) {
                call.reject("store failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun readBase64(call: PluginCall) {
        val id = call.getString("id")
        io.execute {
            try {
                val file = id?.let { fileForId(it) }
                if (file == null) {
                    call.reject("not found")
                    return@execute
                }
                val out = ByteArrayOutputStream(file.length().toInt().coerceAtLeast(1024))
                file.inputStream().use { it.copyTo(out) }
                val result = JSObject()
                result.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
                call.resolve(result)
            } catch (e: Exception) {
                call.reject("read failed: ${e.message}")
            }
        }
    }

    /**
     * 返回可供 WebView 直接加载的文件路径（绝对路径，JS 侧过 convertFileSrc）。
     * 静态图片超过 MAX_DIM 时懒生成缩略图返回 thumbPath；动图/矢量/音视频直出原文件。
     */
    @PluginMethod
    fun resolve(call: PluginCall) {
        val id = call.getString("id")
        io.execute {
            try {
                val file = id?.let { fileForId(it) }
                if (file == null) {
                    call.reject("not found")
                    return@execute
                }
                val result = JSObject()
                result.put("path", file.absolutePath)
                result.put("bytes", file.length())
                if (file.extension.lowercase() in THUMBABLE_EXTS) {
                    val thumb = ensureThumb(id, file)
                    if (thumb != null) result.put("thumbPath", thumb.absolutePath)
                }
                call.resolve(result)
            } catch (e: Exception) {
                call.reject("resolve failed: ${e.message}")
            }
        }
    }

    private fun ensureThumb(id: String?, src: File): File? {
        if (id == null) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(src.absolutePath, bounds)
        val w = bounds.outWidth
        val h = bounds.outHeight
        if (w <= 0 || h <= 0) return null
        if (w <= THUMB_MAX_DIM && h <= THUMB_MAX_DIM) return null

        val thumb = thumbForId(id)
        if (thumb.exists() && thumb.lastModified() >= src.lastModified()) return thumb

        var sample = 1
        while (w / (sample * 2) >= THUMB_MAX_DIM || h / (sample * 2) >= THUMB_MAX_DIM) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        val decoded = BitmapFactory.decodeFile(src.absolutePath, opts) ?: return null
        val scale = minOf(1f, THUMB_MAX_DIM.toFloat() / maxOf(decoded.width, decoded.height))
        val bitmap = if (scale < 1f) {
            Bitmap.createScaledBitmap(
                decoded,
                (decoded.width * scale).toInt().coerceAtLeast(1),
                (decoded.height * scale).toInt().coerceAtLeast(1),
                true,
            ).also { if (it !== decoded) decoded.recycle() }
        } else decoded
        val format = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Bitmap.CompressFormat.WEBP_LOSSY
        } else {
            @Suppress("DEPRECATION")
            Bitmap.CompressFormat.WEBP
        }
        thumb.outputStream().use { bitmap.compress(format, THUMB_QUALITY, it) }
        bitmap.recycle()
        return thumb
    }

    @PluginMethod
    fun delete(call: PluginCall) {
        val id = call.getString("id")
        io.execute {
            val file = id?.let { fileForId(it) }
            file?.delete()
            if (id != null) thumbForId(id).delete()
            call.resolve()
        }
    }

    @PluginMethod
    fun list(call: PluginCall) {
        io.execute {
            try {
                val entries = JSArray()
                mediaDir.listFiles()?.forEach { f ->
                    val entry = JSObject()
                    entry.put("id", f.name.substringBeforeLast('.'))
                    entry.put("ext", f.extension.lowercase())
                    entry.put("bytes", f.length())
                    entry.put("modified", f.lastModified())
                    entries.put(entry)
                }
                val result = JSObject()
                result.put("entries", entries)
                call.resolve(result)
            } catch (e: Exception) {
                call.reject("list failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        io.execute {
            var removed = 0
            mediaDir.listFiles()?.forEach { if (it.delete()) removed++ }
            thumbDir.listFiles()?.forEach { it.delete() }
            val result = JSObject()
            result.put("removed", removed)
            call.resolve(result)
        }
    }

    companion object {
        private const val THUMB_MAX_DIM = 1600
        private const val THUMB_QUALITY = 90
        // webp/gif 可能是动图，svg 不是位图格式——都直出原文件
        private val THUMBABLE_EXTS = setOf("png", "jpg", "jpeg", "bmp")
    }
}
