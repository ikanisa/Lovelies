package android.os
/** No Android elapsed-clock success is fabricated by repository host fixtures. */
object SystemClock { fun elapsedRealtime():Long=error("Android elapsed realtime unavailable in host fixture") }
