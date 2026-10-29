package io.uggs.orchestrator

import android.content.Context
import android.text.format.DateFormat
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import java.util.Locale

/**
 * Resource-backed text for code that is not a composable (formatters, view models, notifications).
 * Pure presentation helpers take a [Texts] so they stay JVM-testable: tests pass an English
 * implementation that reads the real strings XML resource files.
 */
interface Texts {
    val locale: Locale
    fun string(@StringRes id: Int, vararg args: Any): String
    fun plural(@PluralsRes id: Int, count: Int, vararg args: Any): String

    /** Locale-correct date pattern for [skeleton] (e.g. "EEEdMMM"); [fallback] when the platform has none. */
    fun pattern(skeleton: String, fallback: String): String
}

internal class ContextTexts(private val context: Context) : Texts {
    override val locale: Locale get() = context.resources.configuration.locales[0]
    override fun string(@StringRes id: Int, vararg args: Any): String = context.getString(id, *args)
    override fun plural(@PluralsRes id: Int, count: Int, vararg args: Any): String =
        context.resources.getQuantityString(id, count, *args)
    override fun pattern(skeleton: String, fallback: String): String =
        DateFormat.getBestDateTimePattern(locale, skeleton).takeIf { !it.isNullOrBlank() } ?: fallback
}

/** Recomposes with the configuration, so a locale change re-resolves every helper-built text. */
@Composable internal fun rememberTexts(): Texts {
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    return remember(context, configuration) { ContextTexts(context) }
}
