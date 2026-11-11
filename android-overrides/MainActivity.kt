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
  // Invoked through JNI on a worker. ImageDecoder uses Android's installed HEIF codec.
  // Never uploads media and requires no network permission.
  @androidx.annotation.Keep
  fun decodeThumbnail(source: String, target: String): Boolean {
    return try {
      val file = java.io.File(source)
      if (file.length() > 128L * 1024 * 1024) return false
      val bitmap = if (android.os.Build.VERSION.SDK_INT >= 28) {
        android.graphics.ImageDecoder.decodeBitmap(android.graphics.ImageDecoder.createSource(file)) { decoder, info, _ ->
          val scale = minOf(1.0, 320.0 / maxOf(info.size.width, info.size.height))
          decoder.setTargetSize(maxOf(1, (info.size.width * scale).toInt()), maxOf(1, (info.size.height * scale).toInt()))
          decoder.allocator = android.graphics.ImageDecoder.ALLOCATOR_SOFTWARE
        }
      } else {
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeFile(source, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return false
        val options = android.graphics.BitmapFactory.Options()
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 640) sample *= 2
        options.inSampleSize = sample
        val original = android.graphics.BitmapFactory.decodeFile(source, options) ?: return false
        val scale = minOf(1.0, 320.0 / maxOf(original.width, original.height))
        val resized = android.graphics.Bitmap.createScaledBitmap(original, maxOf(1, (original.width * scale).toInt()), maxOf(1, (original.height * scale).toInt()), true)
        if (original !== resized) original.recycle()
        resized
      }
      try {
        val dest = java.io.File(target)
        dest.parentFile?.mkdirs()
        val temporary = java.io.File(target + ".android.tmp")
        temporary.outputStream().use { if (!bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 90, it)) return false }
        temporary.renameTo(dest)
      } finally { bitmap.recycle() }
    } catch (_: Exception) { false } catch (_: OutOfMemoryError) { false }
  }

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
