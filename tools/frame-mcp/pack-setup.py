# -*- coding: utf-8 -*-
"""
把 installer 打成一份可以直接发给别人的 zip。

为什么要有这一步：
- `setup.js` 是纯 Node，但用户不会去敲命令，需要一个 `.cmd` 当入口；
- `dist/frame-mcp.js` 是 esbuild 产物，`installer/setup.js` 认的是 `<包>/server/frame-mcp.js`
  这个位置（见 setup.js 里 `bundledServer()`），所以必须按这个布局重新摆一遍；
- zip 里的文件名一律用 **ASCII**：Windows 资源管理器解 zip 时对非 ASCII 文件名的处理
  在不同版本上不一致，`安装.cmd` 这种名字有可能解出来变乱码。可读性交给 README.txt。

用法：python tools/frame-mcp/pack-setup.py
输出：tools/frame-mcp/dist/frame-mcp-setup.zip
"""
import os
import sys
import zipfile
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))          # 工程根
DIST = os.path.join(HERE, 'dist')
INSTALLER = os.path.join(HERE, 'installer')
OUT = os.path.join(DIST, 'frame-mcp-setup.zip')

PREFIX = 'frame-mcp-setup'


def main():
    bundle = os.path.join(DIST, 'frame-mcp.js')
    if not os.path.exists(bundle):
        sys.stderr.write('找不到 %s ，先跑 node tools/frame-mcp/build.mjs\n' % bundle)
        return 1

    members = [
        (os.path.join(INSTALLER, 'install.cmd'), '%s/install.cmd' % PREFIX),
        (os.path.join(INSTALLER, 'setup.js'), '%s/setup.js' % PREFIX),
        (os.path.join(INSTALLER, 'README.txt'), '%s/README.txt' % PREFIX),
        (bundle, '%s/server/frame-mcp.js' % PREFIX),
    ]
    for src, _arc in members:
        if not os.path.exists(src):
            sys.stderr.write('缺少素材：%s\n' % src)
            return 1

    os.makedirs(DIST, exist_ok=True)
    if os.path.exists(OUT):
        os.remove(OUT)

    stamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for src, arc in members:
            z.write(src, arc)
        info = zipfile.ZipInfo('%s/BUILD.txt' % PREFIX, date_time=datetime.datetime.now().timetuple()[:6])
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, 'packed at %s\nserver size: %.1f MB\n' % (
            stamp, os.path.getsize(bundle) / 1024 / 1024))

    print('packed ->', OUT, '(%.1f MB)' % (os.path.getsize(OUT) / 1024 / 1024))
    print('layout:')
    with zipfile.ZipFile(OUT) as z:
        for n in z.namelist():
            print('   ', n, z.getinfo(n).file_size)
    return 0


if __name__ == '__main__':
    sys.exit(main())
