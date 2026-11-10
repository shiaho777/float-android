package app.pneuma.app

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * 原生 HTTP/SSE 传输层：JS 侧（lib/native-http.ts）把 LLM 等长连接请求
 * 交给 OkHttp 在原生线程上执行，响应体按块经事件回推给 WebView。
 * 好处：socket 读取不受 WebView 节流/页面休眠影响，SSE 缓冲不挤占 JS 堆。
 *
 * 事件协议（均携带 requestId）：
 *  - nativeHttpHead  响应头到达（status + headers），对应 fetch resolve 时机
 *  - nativeHttpChunk 响应体分块（base64，避免 UTF-8 字符被切断）
 *  - nativeHttpDone  流正常结束
 *  - nativeHttpError 网络层失败（status 可能缺失=未拿到响应头）
 *
 * HTTP 非 2xx 不视为网络错误：照常发 head+body，由 JS 按 fetch 语义读错误体。
 */
@CapacitorPlugin(name = "NativeHttp")
class NativeHttpPlugin : Plugin() {

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        // SSE 长连接：两次数据之间可能安静几分钟，读超时交给 JS 侧 AbortController 管
        .readTimeout(0, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val activeCalls = ConcurrentHashMap<String, Call>()

    @PluginMethod
    fun start(call: PluginCall) {
        val requestId = call.getString("requestId")
        val url = call.getString("url")
        if (requestId.isNullOrEmpty() || url.isNullOrEmpty()) {
            call.reject("requestId and url are required")
            return
        }
        if (activeCalls.containsKey(requestId)) {
            call.reject("duplicate requestId")
            return
        }

        val builder = Request.Builder().url(url)
        val headers = call.getObject("headers")
        if (headers != null) {
            val keys = headers.keys()
            while (keys.hasNext()) {
                val name = keys.next()
                val value = headers.getString(name) ?: continue
                try {
                    builder.header(name, value)
                } catch (e: IllegalArgumentException) {
                    call.reject("invalid header: $name")
                    return
                }
            }
        }

        val method = (call.getString("method") ?: "POST").uppercase()
        val bodyText = call.getString("body")
        // 二进制体（FormData/Blob/ArrayBuffer 等）由 JS 侧编码成 base64 过桥
        val bodyBase64 = call.getBoolean("bodyBase64") == true
        if (bodyText != null && method != "GET" && method != "HEAD") {
            var contentType = "application/json; charset=utf-8"
            if (headers != null) {
                val keys = headers.keys()
                while (keys.hasNext()) {
                    val name = keys.next()
                    if (name.equals("Content-Type", ignoreCase = true)) {
                        contentType = headers.getString(name) ?: contentType
                    }
                }
            }
            val mediaType = contentType.toMediaTypeOrNull()
            val requestBody = if (bodyBase64) {
                Base64.decode(bodyText, Base64.DEFAULT).toRequestBody(mediaType)
            } else {
                bodyText.toRequestBody(mediaType)
            }
            builder.method(method, requestBody)
        } else {
            builder.method(method, null)
        }

        val okCall: Call
        try {
            okCall = client.newCall(builder.build())
        } catch (e: IllegalArgumentException) {
            call.reject("invalid request: ${e.message}")
            return
        }
        activeCalls[requestId] = okCall
        okCall.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                // cancel() 触发的 onFailure 不回事件——JS 侧 abort 已自行收尾
                if (activeCalls.remove(requestId) != null && !call.isCanceled()) {
                    emitError(requestId, null, e.message ?: "network error")
                }
            }

            override fun onResponse(call: Call, response: Response) {
                try {
                    emitHead(requestId, response)
                    val input = response.body?.byteStream()
                    if (input == null) {
                        emitDone(requestId)
                        return
                    }
                    val buf = ByteArray(CHUNK_BYTES)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        if (n == 0) continue
                        emitChunk(requestId, buf, n)
                    }
                    emitDone(requestId)
                } catch (e: Exception) {
                    // IOException=流中断；RuntimeException=桥事件异常——都得让 JS 收尾
                    if (!call.isCanceled()) emitError(requestId, response.code, e.message ?: "stream error")
                } finally {
                    response.close()
                    activeCalls.remove(requestId)
                }
            }
        })
        call.resolve()
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val requestId = call.getString("requestId")
        if (requestId != null) {
            activeCalls.remove(requestId)?.cancel()
        }
        call.resolve()
    }

    private fun emitHead(requestId: String, response: Response) {
        val headers = JSObject()
        for (name in response.headers.names()) {
            headers.put(name, response.header(name))
        }
        val payload = JSObject()
        payload.put("requestId", requestId)
        payload.put("status", response.code)
        payload.put("headers", headers)
        emit("nativeHttpHead", payload)
    }

    private fun emitChunk(requestId: String, buf: ByteArray, n: Int) {
        val payload = JSObject()
        payload.put("requestId", requestId)
        payload.put("data", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP))
        emit("nativeHttpChunk", payload)
    }

    private fun emitDone(requestId: String) {
        val payload = JSObject()
        payload.put("requestId", requestId)
        emit("nativeHttpDone", payload)
    }

    private fun emitError(requestId: String, status: Int?, error: String) {
        val payload = JSObject()
        payload.put("requestId", requestId)
        if (status != null && status > 0) payload.put("status", status)
        payload.put("error", error)
        emit("nativeHttpError", payload)
    }

    private fun emit(event: String, payload: JSObject) {
        try {
            notifyListeners(event, payload)
        } catch (e: RuntimeException) {
            // 桥已销毁（页面重建等）：丢弃事件，调用本身随进程结束
        }
    }

    companion object {
        // 16KB 分块：桥消息大小与 dispatch 频率的折中
        private const val CHUNK_BYTES = 16 * 1024
    }
}
