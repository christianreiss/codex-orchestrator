package io.uggs.orchestrator

import org.json.JSONArray

fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }
fun JSONArray.strings() = (0 until length()).map { getString(it) }.toSet()
