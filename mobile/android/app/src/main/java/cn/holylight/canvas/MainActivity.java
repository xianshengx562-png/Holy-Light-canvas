package cn.holylight.canvas;

import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final int REQ_STORAGE = 4001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NetworkFixPlugin.class);
        registerPlugin(RawHttpPlugin.class);
        super.onCreate(savedInstanceState);
        /* 启动先探一次网络通路（结果 CDP 能读到），别等第一次请求失败才发现。 */
        NetworkFix.probeInBackground(this, null);
        ensureStoragePermission();
    }

    /*
     * 存图权限：Android 10+ 用 MediaStore 插自己创建的条目不需要权限（分区存储）；
     * Android 9 及以下写公共目录要 WRITE_EXTERNAL_STORAGE 运行时权限 —— 这里主动申请，
     * 保证「出图自动落盘」在老系统上也不缺权限。
     */
    private void ensureStoragePermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
            == PackageManager.PERMISSION_GRANTED) return;
        ActivityCompat.requestPermissions(
            this,
            new String[] { Manifest.permission.WRITE_EXTERNAL_STORAGE },
            REQ_STORAGE
        );
    }
}
