package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test

class PolicyLinksTest {
    @Test fun onlyConfiguredPublicHttpsPolicyAddressesAreOpened() {
        assertTrue(PolicyLinks.valid("https://example.org/privacy"))
        assertTrue(PolicyLinks.valid("https://example.org:443/terms"))
        listOf("","http://example.org/privacy","file:///privacy.html","https://user:secret@example.org/privacy",
            "https://example.org:444/privacy","https://example.org/privacy?token=private","https://example.org/privacy#section",
            "https://example.org/a/../privacy","https://example.org/privacy\n").forEach { assertFalse(it,PolicyLinks.valid(it)) }
    }
}
