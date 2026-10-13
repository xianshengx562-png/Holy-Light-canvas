package cn.holylight.canvas;

import android.content.Context;
import android.net.ConnectivityManager;
import java.io.Closeable;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 网络自救（2026-10-13）。
 *
 * ## 为什么是这个东西
 *
 * 真机实锤的故障：在这台 ColorOS 上，本 App 用 OkHttp / HttpURLConnection（即 CapacitorHttp）
 * 发的所有出站连接**几毫秒内被本地拒绝** —— 换 WiFi / 换流量 / 杀 App 重开、甚至重启手机都没用；
 * 但下面几种是通的：
 *   - `toybox nc`（shell 里，走内核路由）
 *   - 手机浏览器、以及**同进程 WebView**（chromium 自己挑网络）
 * 推测是 netd 给这个进程/UID 的 socket 打的 fwmark 把它指到了一张坏路由表。
 *
 * ## 所以这里做什么
 *
 * 不依赖任何权限（`getAllNetworks` 那套要 ACCESS_NETWORK_STATE，这台机器上 manifest 声明被合并器吃掉），
 * 只用公开的低层手段，逐个试出一条能出站的 socket 通路：
 *   1. 原样裸 socket（基线）；
 *   2. `bindProcessToNetwork(null)` 解绑进程的网络，退回内核路由（= nc 走的路）；
 *   3. 把 socket 绑到具体网卡的本地 IP（wlan / rmnet），绕过 fwmark 选路。
 * 通的那一招留作后续请求复用的模板。
 */
public final class NetworkFix {

    private static final String PROBE_HOST = "www.myvigna.top";
    private static final int PROBE_PORT = 443;
    private static final int PROBE_TIMEOUT_MS = 4000;

    /** 探测结论：给 CDP 看，也留着以后自动选路用。 */
    public static final class Result {
        public String raw = "";          // 裸 socket
        public String unbound = "";      // 解绑进程网络后
        public List<String> bound = new ArrayList<>(); // 绑到具体网卡 IP
        public String best = "";         // 能通的那招名
    }

    public interface Done { void onDone(Result result); }

    public static void probeInBackground(Context context, Done done) {
        final Context app = context.getApplicationContext();
        new Thread(() -> {
            Result r = probe(app);
            if (done != null) done.onDone(r);
        }, "hl-net-probe").start();
    }

    public static Result probe(Context context) {
        Result r = new Result();
        /* 1. 基线：什么都不做，普通 socket 出站。 */
        r.raw = tryConnect(null, null);
        if (r.raw.startsWith("ok")) {
            r.best = "raw";
            return r;
        }

        /* 2. 解绑：回到内核默认路由 —— nc 走的就是这条路。 */
        try {
            ConnectivityManager cm =
                (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) cm.bindProcessToNetwork(null);
        } catch (Exception e) {
            r.unbound = "unbind-failed: " + e.getMessage();
        }
        r.unbound = tryConnect(null, null);
        if (r.unbound.startsWith("ok")) {
            r.best = "unbound";
            return r;
        }

        /* 3. 绑到具体网卡：wlan / wlan1 / rmnet_data*。 */
        for (String iface : candidateInterfaces()) {
            InetAddress local = localAddress(iface);
            if (local == null) continue;
            String outcome = tryConnect(local, iface);
            r.bound.add(iface + "=" + outcome);
            if (outcome.startsWith("ok")) {
                r.best = "bind:" + iface;
                return r;
            }
        }
        r.best = r.bound.isEmpty() ? "none" : "try-bound";
        return r;
    }

    /** DNS + TCP connect。`bind` 为空表示不绑本地地址。 */
    private static String tryConnect(InetAddress bind, String iface) {
        Socket socket = null;
        try {
            InetAddress target = InetAddress.getAllByName(PROBE_HOST)[0];
            socket = new Socket();
            if (bind != null) socket.bind(new InetSocketAddress(bind, 0));
            socket.connect(new InetSocketAddress(target, PROBE_PORT), PROBE_TIMEOUT_MS);
            String via = iface == null ? "" : " via " + iface;
            return "ok " + target.getHostAddress() + via + " local=" + socket.getLocalAddress();
        } catch (Exception e) {
            return "fail " + e.getMessage();
        } finally {
            close(socket);
        }
    }

    /** 值得一试的网卡：WiFi 和蜂窝，按名字排序，wlan 优先。 */
    private static List<String> candidateInterfaces() {
        List<String> out = new ArrayList<>();
        try {
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                String name = nif.getName();
                if (name.startsWith("wlan") || name.startsWith("rmnet") || name.startsWith("ccmni")
                    || name.startsWith("eth")) {
                    out.add(name);
                }
            }
        } catch (Exception ignored) {
            /* NetworkInterface 不需要权限，失败就当没找到 */
        }
        Collections.sort(out);
        return out;
    }

    private static InetAddress localAddress(String iface) {
        try {
            NetworkInterface nif = NetworkInterface.getByName(iface);
            if (nif == null) return null;
            for (InetAddress address : Collections.list(nif.getInetAddresses())) {
                /* 只要 IPv4：X86/IPv6 走不同路由表，混着试会误导结论。 */
                if (address instanceof java.net.Inet4Address) return address;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static void close(Closeable closeable) {
        if (closeable == null) return;
        try { closeable.close(); } catch (Exception ignored) { }
    }

    private NetworkFix() { }
}
