"""PyInstaller 入口：启动 DeepSpeak 本地服务器。

侧车（sidecar）模式：Electron 主进程以 --port <随机> --no-browser 拉起本程序。
"""
from backend import server

if __name__ == "__main__":
    server.main()
