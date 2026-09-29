/**
 * 「记住我」勾选框。默认不勾 —— 不勾时服务端只发一个会话 cookie，关掉浏览器即失效。
 * 纯表单控件，不需要客户端 JS：两个 auth 页面共用同一段标记，避免两边文案走偏。
 */
export default function RememberField() {
  return (
    <label className="auth-remember">
      <input name="remember" type="checkbox" value="on" />
      <span>记住我<span className="auth-remember-hint"> · 这台设备 7 天内免登录</span></span>
    </label>
  );
}
