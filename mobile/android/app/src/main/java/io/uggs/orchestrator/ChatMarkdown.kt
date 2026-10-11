package io.uggs.orchestrator

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp

/** Display agent Markdown as native text; HTML is never evaluated. */
@Composable internal fun ChatMarkdown(text:String, modifier:Modifier=Modifier) {
    Column(modifier) {
        text.split("```").forEachIndexed { index, block ->
            if(index % 2 == 1) Surface(shape=RoundedCornerShape(6.dp),color=MaterialTheme.colorScheme.surfaceVariant,modifier=Modifier.fillMaxWidth().padding(vertical=4.dp)) {
                Text(block.substringAfter('\n',block).trimEnd(),Modifier.padding(10.dp),fontFamily=FontFamily.Monospace,style=MaterialTheme.typography.bodySmall)
            } else block.trimEnd().lines().forEach { line ->
                val heading=line.startsWith("#") && line.substringBefore(' ').all { it == '#' }
                val body=if(heading) line.substringAfter(' ') else if(line.startsWith("- ") || line.startsWith("* ")) "• "+line.drop(2) else line
                val annotated=buildAnnotatedString {
                    var offset=0
                    Regex("(\\*\\*[^*]+\\*\\*|`[^`]+`)").findAll(body).forEach { match ->
                        append(body.substring(offset,match.range.first))
                        val code=match.value.startsWith("`")
                        withStyle(if(code) SpanStyle(fontFamily=FontFamily.Monospace) else SpanStyle(fontWeight=FontWeight.Bold)) { append(match.value.substring(if(code) 1 else 2,match.value.length-(if(code) 1 else 2))) }
                        offset=match.range.last+1
                    }
                    append(body.substring(offset))
                }
                Text(annotated,style=if(heading) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyLarge,modifier=Modifier.padding(vertical=1.dp))
            }
        }
    }
}
