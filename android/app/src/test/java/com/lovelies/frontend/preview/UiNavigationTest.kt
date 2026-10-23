package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test

class UiNavigationTest {
    @Test fun everyDirectReferenceScreenHasAnExitWithoutALoop() {
        for(route in 1..48) {
            var current=route
            val visited=mutableSetOf<Int>()
            while(true) {
                assertTrue("Back loop from $route at $current",visited.add(current))
                val next=fallbackBackRoute(current) ?: break
                assertTrue("Invalid destination from $current",next in 1..48)
                current=next
            }
            assertTrue("Unreachable root from $route",current in setOf(1,10))
        }
        assertNull(fallbackBackRoute(1));assertNull(fallbackBackRoute(10))
    }
    @Test fun uploadSharingAndDeepSettingsKeepTheirTaskContext() {
        assertEquals(19,fallbackBackRoute(20));assertEquals(20,fallbackBackRoute(21))
        assertEquals(21,fallbackBackRoute(22));assertEquals(22,fallbackBackRoute(23))
        assertEquals(29,fallbackBackRoute(31));assertEquals(31,fallbackBackRoute(33))
        assertEquals(33,fallbackBackRoute(34));assertEquals(15,fallbackBackRoute(16))
        for(route in 38..46)assertEquals(37,fallbackBackRoute(route))
    }
}
