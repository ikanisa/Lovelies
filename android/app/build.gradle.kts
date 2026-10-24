import java.net.URI
import java.util.Properties
import java.security.KeyStore
import java.security.MessageDigest
import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val uploadPropertiesFile = file(providers.gradleProperty("loveliesSigningPropertiesFile").orElse(rootProject.file("../.release-secrets/android/signing.properties").absolutePath).get())
val uploadProperties = Properties().apply { if(uploadPropertiesFile.isFile)uploadPropertiesFile.inputStream().use { load(it) } }
val uploadStore = uploadProperties.getProperty("storeFile")?.let { value ->
    File(value).takeIf { it.isAbsolute } ?: uploadPropertiesFile.parentFile.resolve(value)
}

android {
    namespace = "com.lovelies.frontend.preview"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.lovelies.memories"
        minSdk = 26
        targetSdk = 36
        resourceConfigurations += listOf("en", "rw")
        versionCode = providers.gradleProperty("loveliesVersionCode").orElse("18").get().toInt().also { require(it >= 18) { "This replacement candidate starts at versionCode 18; verify the current Play Console maximum before release." } }
        versionName = providers.gradleProperty("loveliesVersionName").orElse("2.0.0").get()
        buildConfigField("String", "FACE_TOKEN_ISSUER", "\"${providers.gradleProperty("loveliesTokenIssuer").orElse("lovelies-supabase").get()}\"")
        buildConfigField("String", "PLAY_SUBSCRIPTION_PRODUCT", "\"${providers.gradleProperty("loveliesPlayProduct").orElse("").get()}\"")
        buildConfigField("String", "LINK_HOST", "\"${providers.gradleProperty("loveliesLinkHost").orElse("lovelies.app").get()}\"")
        buildConfigField("String", "FIREBASE_PROJECT_ID", "\"${providers.gradleProperty("loveliesFirebaseProjectId").orElse("").get()}\"")
        buildConfigField("String", "FIREBASE_APP_ID", "\"${providers.gradleProperty("loveliesFirebaseAppId").orElse("").get()}\"")
        buildConfigField("String", "FIREBASE_API_KEY", "\"${providers.gradleProperty("loveliesFirebaseApiKey").orElse("").get()}\"")
        buildConfigField("String", "FIREBASE_SENDER_ID", "\"${providers.gradleProperty("loveliesFirebaseSenderId").orElse("").get()}\"")
        listOf("PRIVACY_POLICY_URL" to "loveliesPrivacyPolicyUrl","TERMS_URL" to "loveliesTermsUrl","DELETION_URL" to "loveliesDeletionUrl").forEach { (constant,property)->
            val value=providers.gradleProperty(property).orElse("").get().replace("\\","\\\\").replace("\"","\\\"")
            buildConfigField("String",constant,"\"$value\"")
        }
        manifestPlaceholders["loveliesLinkHost"] = providers.gradleProperty("loveliesLinkHost").orElse("lovelies.app").get()
        testInstrumentationRunner = providers.gradleProperty("loveliesTestRunner").orElse("com.lovelies.frontend.preview.NativeCloudflareJourney").get()
        buildConfigField("String", "API_BASE_URL", "\"${providers.gradleProperty("loveliesApiUrl").orElse("").get().replace("\\", "\\\\").replace("\"", "\\\"")}\"")
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            buildConfigField("Boolean", "REFERENCE_SCREENS", "false")
        }
        debug { buildConfigField("Boolean", "REFERENCE_SCREENS", "true"); buildConfigField("String", "API_BASE_URL", "\"${providers.gradleProperty("loveliesDebugApiUrl").orElse("http://10.0.2.2:8787").get().replace("\\", "\\\\").replace("\"", "\\\"")}\"") }
    }
    // Screenshot fixture photos are confined to src/debug/assets.
    signingConfigs {
        if(uploadPropertiesFile.isFile)create("loveliesUpload") {
            storeFile = uploadStore
            storePassword = uploadProperties.getProperty("storePassword")
            keyAlias = uploadProperties.getProperty("keyAlias")
            keyPassword = uploadProperties.getProperty("keyPassword")
        }
    }
    buildTypes.getByName("release").signingConfig = signingConfigs.findByName("loveliesUpload")
    buildFeatures { compose = true; buildConfig = true }
    providers.gradleProperty("loveliesJourneyFixturesDir").orNull?.let {
        sourceSets.getByName("androidTest").assets.srcDir(it)
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

// Missing provider/policy values must not silently produce a store candidate.
val validateLoveliesRelease=tasks.register("validateLoveliesRelease") {
    doLast {
        val required=listOf("loveliesApiUrl","loveliesPrivacyPolicyUrl","loveliesTermsUrl","loveliesDeletionUrl",
            "loveliesPlayProduct","loveliesLinkHost","loveliesFirebaseProjectId","loveliesFirebaseAppId","loveliesFirebaseApiKey","loveliesFirebaseSenderId")
        val values=required.associateWith { providers.gradleProperty(it).orNull.orEmpty() }
        val missing=values.filterValues(String::isBlank).keys
        require(missing.isEmpty()) { "Missing Lovelies release configuration: ${missing.joinToString()}. Supply verified release inputs; values are not printed." }
        val highestUploaded = providers.gradleProperty("loveliesKnownHighestPlayVersionCode").orNull?.toIntOrNull()
        require(highestUploaded != null && highestUploaded >= 0 && android.defaultConfig.versionCode!! > highestUploaded) { "Set loveliesKnownHighestPlayVersionCode from a fresh all-track Play Console readback; the candidate must be higher." }
        require(uploadPropertiesFile.isFile && uploadStore?.isFile==true && listOf("storePassword","keyAlias","keyPassword").all { !uploadProperties.getProperty(it).isNullOrBlank() }) { "Supply the private Lovelies upload signing properties and existing keystore; no debug-key fallback is allowed." }
        val expectedFingerprint=providers.gradleProperty("loveliesExpectedUploadCertificateSha256").orNull?.replace(":","")?.uppercase()
        require(expectedFingerprint!=null && Regex("[0-9A-F]{64}").matches(expectedFingerprint)) { "Set loveliesExpectedUploadCertificateSha256 from the current Play upload certificate." }
        val password=uploadProperties.getProperty("storePassword").toCharArray()
        val actualFingerprint=try {
            val keyStore=KeyStore.getInstance(uploadStore!!,password)
            val certificate=keyStore.getCertificate(uploadProperties.getProperty("keyAlias")) ?: error("The upload certificate is missing")
            MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02X".format(it) }
        } finally { password.fill('\u0000') }
        require(actualFingerprint==expectedFingerprint) { "The private upload key does not match the current Play upload certificate." }
        listOf("loveliesApiUrl","loveliesPrivacyPolicyUrl","loveliesTermsUrl","loveliesDeletionUrl").forEach { key ->
            val uri=runCatching { URI(values.getValue(key)) }.getOrNull()
            require(uri!=null && uri.scheme=="https" && !uri.host.isNullOrBlank() && uri.userInfo==null && uri.port in setOf(-1,443) && uri.query==null && uri.fragment==null && uri.normalize()==uri) { "Invalid HTTPS release URL in $key" }
        }
        require(values.getValue("loveliesApiUrl").trimEnd('/')=="https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api") { "Release API must target the selected Lovelies Supabase function." }
        require(Regex("^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\\.[A-Za-z]{2,}$").matches(values.getValue("loveliesLinkHost"))) { "Set the verified HTTPS App Links host." }
    }
}
tasks.matching { it.name=="preReleaseBuild" }.configureEach { dependsOn(validateLoveliesRelease) }

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.10.01"))
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material:material")
    implementation("androidx.compose.material:material-icons-core:1.7.8")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.work:work-runtime-ktx:2.10.5")
    implementation("com.android.billingclient:billing:9.1.0")
    implementation("com.google.firebase:firebase-messaging:25.0.1")
    testImplementation("junit:junit:4.13.2")
}
