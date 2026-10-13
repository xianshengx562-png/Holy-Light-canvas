package cn.holylight.canvas;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 绕开系统代理的 HTTP 通道（2026-10-13）。
 *
 * ## 为什么需要它
 *
 * 真机实锤：这台 ColorOS 上 CapacitorHttp（内部 HttpURLConnection）发的请求全部
 * 几毫秒被本地拒绝 —— 而**同一个进程里裸 `new Socket()` 出站完全正常**（见 NetworkFix）。
 * 两者最大的差别之一：HttpURLConnection 会走 `ProxySelector.getDefault()`，
 * 系统网络引擎注入的 JVM 级代理；代理端口没人听，连接就瞬时被拒。
 *
 * ## 做法
 *
 * `URL.openConnection(Proxy.NO_PROXY)` —— 同一个 HttpURLConnection 实现，
 * 但明确指定不走代理，行为等价于裸 socket。纯 JDK，不引新依赖。
 *
 * JS 端 `send()` 的原生分支**优先**走它，失败再退回 CapacitorHttp、WebView fetch。
 */
@CapacitorPlugin(name = "RawHttp")
public class RawHttpPlugin extends Plugin {

    @PluginMethod
    public void request(final PluginCall call) {
        final String url = call.getString("url");
        final String method = call.getString("method", "GET");
        final JSObject headers = call.getObject("headers", new JSObject());
        final String body = call.getString("body", null);
        final int timeoutMs = call.getInt("timeoutMs", 30_000);

        if (url == null || url.isEmpty()) {
            call.reject("url 不能为空");
            return;
        }

        /* 网络 IO 不能占 bridge 线程，开Worker。 */
        new Thread(() -> {
            JSObject out = new JSObject();
            HttpURLConnection connection = null;
            try {
                /* 🔴 关键：NO_PROXY —— 不问 ProxySelector、不读系统代理属性。 */
                connection = (HttpURLConnection) new URL(url).openConnection(Proxy.NO_PROXY);
                connection.setRequestMethod(method.toUpperCase());
                connection.setConnectTimeout(Math.max(1000, timeoutMs));
                connection.setReadTimeout(Math.max(1000, timeoutMs));
                /* 自己对 302 做判断（中转站偶尔把 302 指到对象存储），别让原生层自动跟随。 */
                connection.setInstanceFollowRedirects(false);
                /* 不用 Keep-Alive：池里躺着的坏连接会把后续请求全带沟里。 */
                connection.setRequestProperty("Connection", "close");
                /* JSObject.keys() 给的是 Iterator，不能走 for-each。 */
                java.util.Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    String value = headers.getString(key, "");
                    if (!value.isEmpty()) connection.setRequestProperty(key, value);
                }

                boolean hasBody = body != null && !body.isEmpty()
                    && !"GET".equalsIgnoreCase(method) && !"HEAD".equalsIgnoreCase(method);
                if (hasBody) {
                    connection.setDoOutput(true);
                    OutputStream stream = connection.getOutputStream();
                    try {
                        stream.write(body.getBytes(StandardCharsets.UTF_8));
                        stream.flush();
                    } finally {
                        close(stream);
                    }
                }

                int status = connection.getResponseCode();
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                String text = readAll(stream);
                out.put("status", status);
                out.put("data", text);
                call.resolve(out);
            } catch (Exception e) {
                out.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
                call.resolve(out);
            } finally {
                if (connection != null) connection.disconnect();
            }
        }, "hl-raw-http").start();
    }

    private static String readAll(InputStream stream) throws IOException {
        if (stream == null) return "";
        try {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = stream.read(chunk)) > 0) buffer.write(chunk, 0, read);
            return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            close(stream);
        }
    }

    private static void close(java.io.Closeable closeable) {
        if (closeable == null) return;
        try { closeable.close(); } catch (Exception ignored) { }
    }
}
