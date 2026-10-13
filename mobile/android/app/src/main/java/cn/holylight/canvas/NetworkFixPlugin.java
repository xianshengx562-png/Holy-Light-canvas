package cn.holylight.canvas;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;

/** 给 JS 的网络探针/自救入口。核心逻辑在 {@link NetworkFix}，这里只是桥。 */
@CapacitorPlugin(name = "NetworkFix")
public class NetworkFixPlugin extends Plugin {

    @PluginMethod
    public void probe(PluginCall call) {
        NetworkFix.probeInBackground(getContext(), result -> {
            JSObject out = new JSObject();
            out.put("raw", result.raw);
            out.put("unbound", result.unbound);
            List<String> bound = new ArrayList<>(result.bound);
            out.put("bound", bound);
            out.put("best", result.best);
            call.resolve(out);
        });
    }
}
