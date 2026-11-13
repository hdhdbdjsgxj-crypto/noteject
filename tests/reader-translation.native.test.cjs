const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workspace = path.resolve(__dirname, '..');
const toolchain = path.join(workspace, 'android/.toolchain');
const jdkRoot = path.join(toolchain, 'jdk');
const jdk = fs.existsSync(jdkRoot) && fs.readdirSync(jdkRoot, { withFileTypes: true }).find(item => item.isDirectory());
const java = jdk && path.join(jdkRoot, jdk.name, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const gradleLib = path.join(toolchain, 'gradle/gradle-8.9/lib');
const stdlib = path.join(gradleLib, 'kotlin-stdlib-1.9.23.jar');

test('Reader translation launches Google Translate with browser fallback and bounded selected text', {
  skip: !java || !fs.existsSync(java) || !fs.existsSync(stdlib) ? 'Bundled Android JDK and Kotlin compiler are needed.' : false,
  timeout: 90000,
}, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'noteject-translation-checks-'));
  const files = {
    'ReaderLanguage.kt': `package com.noteject.app
internal object ReaderLanguage { fun text(source: String): String = source }
`,
    'Activity.kt': `package android.app
import android.content.Intent
class Activity {
    val attempts = mutableListOf<Intent>()
    val messages = mutableListOf<String>()
    var launch: (Intent) -> Unit = {}
    fun startActivity(intent: Intent) { attempts.add(intent); launch(intent) }
}`,
    'Intent.kt': `package android.content
import android.net.Uri
class ActivityNotFoundException : RuntimeException()
class Intent(val action: String, val uri: Uri? = null) {
    var mime: String? = null; var target: String? = null
    val extras = mutableMapOf<String, Any>()
    var shared: Intent? = null
    fun setType(value: String) = apply { mime = value }
    fun setPackage(value: String) = apply { target = value }
    fun putExtra(key: String, value: String) = apply { extras[key] = value }
    fun putExtra(key: String, value: Boolean) = apply { extras[key] = value }
    companion object {
        const val ACTION_PROCESS_TEXT = "process"; const val ACTION_VIEW = "view"; const val ACTION_SEND = "send"
        const val EXTRA_PROCESS_TEXT = "process_text"; const val EXTRA_PROCESS_TEXT_READONLY = "readonly"; const val EXTRA_TEXT = "text"
        fun createChooser(intent: Intent, title: String) = Intent("chooser").apply { shared = intent }
    }
}`,
    'Uri.kt': `package android.net
class Uri(val scheme: String, val host: String, val path: String, val query: Map<String, String>) {
    class Builder {
        private var scheme = ""; private var host = ""; private var path = ""
        private val query = mutableMapOf<String, String>()
        fun scheme(value: String) = apply { scheme = value }
        fun authority(value: String) = apply { host = value }
        fun path(value: String) = apply { path = value }
        fun appendQueryParameter(key: String, value: String) = apply { query[key] = value }
        fun build() = Uri(scheme, host, path, query.toMap())
    }
}`,
    'Toast.kt': `package android.widget
import android.app.Activity
class Toast(private val activity: Activity, private val text: String) {
    fun show() { activity.messages.add(text) }
    companion object { const val LENGTH_LONG = 1; fun makeText(activity: Activity, text: String, duration: Int) = Toast(activity, text) }
}`,
    'Checks.kt': `package com.noteject.app
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import java.util.Locale
object TranslationChecks {
    @JvmStatic fun main(args: Array<String>) {
        Locale.setDefault(Locale.US)
        val native = Activity()
        ReaderExternalActions.translate(native, "  hello & 世界😀  ")
        val request = native.attempts.single()
        check(request.action == Intent.ACTION_PROCESS_TEXT && request.target == "com.google.android.apps.translate")
        check(request.mime == "text/plain" && request.extras[Intent.EXTRA_PROCESS_TEXT] == "hello & 世界😀")
        check(request.extras[Intent.EXTRA_PROCESS_TEXT_READONLY] == true)
        val fallback = Activity().apply { launch = { if (it.action == Intent.ACTION_PROCESS_TEXT) throw ActivityNotFoundException() } }
        ReaderExternalActions.translate(fallback, "a & b?#😀\\nnext")
        val uri = fallback.attempts.last().uri!!
        check(fallback.attempts.size == 2 && uri.scheme == "https" && uri.host == "translate.google.com")
        check(uri.query == mapOf("sl" to "auto", "tl" to "en", "text" to "a & b?#😀\\nnext", "op" to "translate"))
        val denied = Activity().apply { launch = { if (it.action == Intent.ACTION_PROCESS_TEXT) throw SecurityException() } }
        ReaderExternalActions.translate(denied, "bonjour")
        check(denied.attempts.last().action == Intent.ACTION_VIEW)
        val missing = Activity().apply { launch = { throw ActivityNotFoundException() } }
        ReaderExternalActions.translate(missing, "hello")
        check(missing.attempts.size == 2 && missing.messages.single().contains("Install Google Translate"))
        val blank = Activity(); ReaderExternalActions.translate(blank, " "); check(blank.attempts.isEmpty() && blank.messages.size == 1)
        val large = Activity(); ReaderExternalActions.translate(large, "a".repeat(5001)); check(large.attempts.isEmpty() && large.messages.single().contains("5,000"))
        val emoji = Activity(); ReaderExternalActions.translate(emoji, "😀".repeat(5000)); check(emoji.attempts.size == 1)
        val shared = Activity(); ReaderExternalActions.share(shared, "  passage  ")
        check(shared.attempts.single().shared!!.extras[Intent.EXTRA_TEXT] == "passage")
        val oversize = Activity(); ReaderExternalActions.share(oversize, "x".repeat(200001)); check(oversize.attempts.isEmpty() && oversize.messages.size == 1)
        println("12 Reader external action checks passed.")
    }
}`,
  };
  const jar = path.join(temporary, 'checks.jar');
  try {
    const stubs = Object.entries(files).map(([name, source]) => {
      const file = path.join(temporary, name); fs.writeFileSync(file, source); return file;
    });
    const compilation = spawnSync(java, [
      '-cp', path.join(gradleLib, '*'), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
      '-no-stdlib', '-no-reflect', '-classpath', stdlib, '-d', jar,
      path.join(workspace, 'android/app/src/main/java/com/noteject/app/ReaderExternalActions.kt'), ...stubs,
    ], { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(compilation.error, undefined, compilation.error?.message);
    assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr);
    const execution = spawnSync(java, ['-cp', [jar, stdlib].join(path.delimiter), 'com.noteject.app.TranslationChecks'], {
      cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 20000,
    });
    assert.equal(execution.error, undefined, execution.error?.message);
    assert.equal(execution.status, 0, execution.stdout + execution.stderr);
    assert.match(execution.stdout, /12 Reader external action checks passed/);
    process.stdout.write(execution.stdout);
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.match(path.basename(temporary), /^noteject-translation-checks-/);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
