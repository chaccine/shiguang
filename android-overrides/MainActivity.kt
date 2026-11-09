// 拾光 Android 入口（覆盖 `tauri android init` 生成的模板；CI 在 init 后复制到 gen/android）。
// Android 15+（targetSdk 35+）强制 edge-to-edge，WebView 内 env(safe-area-inset-*) 常为 0，
// 所以在原生侧把状态栏 / 导航栏 / 刘海 / 输入法 insets 作为根视图 padding，网页不再画到系统栏下面。
package com.shiguang.unit0

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // 界面固定浅色（color-scheme: light）：系统栏用透明底 + 深色图标，避免深色模式下白字看不清。
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
    val content = findViewById<View>(android.R.id.content)
    // 系统栏背后的颜色与顶部栏（.sidebar #ead9c6）一致。
    content.setBackgroundColor(Color.parseColor("#EAD9C6"))
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }
}
