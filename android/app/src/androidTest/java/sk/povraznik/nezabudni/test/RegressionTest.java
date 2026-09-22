package sk.povraznik.nezabudni.test;

import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class RegressionTest {
    private MainActivity activity;
    private String evaluate(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        // onActivity waits for global UI idleness, which a live alarm WebView
        // need not reach. Post this bounded operation directly to the UI thread.
        activity.runOnUiThread(() -> activity.getBridge().getWebView().evaluateJavascript(script, value -> { result.set(value); latch.countDown(); }));
        assertTrue("WebView did not respond", latch.await(10, TimeUnit.SECONDS));
        return result.get();
    }
    private String asset(String name) throws Exception {
        try (java.io.InputStream stream = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(name)) {
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
    @Test(timeout = 180000) public void launchAndRunRegressionScenarios() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(value -> activity = value);
            boolean ready = false;
            for (int i=0; i<100; i++) {
                if ("true".equals(evaluate(scenario,"!!document.getElementById('loginForm')"))) { ready=true; break; }
                Thread.sleep(100);
            }
            assertTrue("Installed APK must load its login UI",ready);
            String html = asset("fixture.html");
            activity.runOnUiThread(() -> {
                WebView web=activity.getBridge().getWebView();
                web.loadDataWithBaseURL("https://localhost",html,"text/html","UTF-8",null);
            });
            Thread.sleep(700);
            evaluate(scenario,asset("scenarios.js"));
            String result="null";
            String captured="";
            for(int i=0;i<200;i++) {
                String checkpoint = new JSONArray("["+evaluate(scenario,"window.__androidCheckpoint || ''")+"]").getString(0);
                if (!checkpoint.isEmpty() && !checkpoint.equals(captured)) {
                    assertTrue("Unexpected screenshot name", checkpoint.matches("[a-z-]+"));
                    java.io.File file = new java.io.File(InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null), checkpoint+".png");
                    android.graphics.Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
                    assertNotNull("Screenshot missing",bitmap);
                    try (java.io.FileOutputStream output = new java.io.FileOutputStream(file)) {
                        assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,output));
                    }
                    captured=checkpoint;
                    evaluate(scenario,"window.__androidContinue=true");
                }
                result=evaluate(scenario,"JSON.stringify(window.__androidReview || null)");
                if (result.contains("checks")) break;
                Thread.sleep(100);
            }
            JSONObject report = new JSONObject(new JSONArray("["+result+"]").getString(0));
            assertTrue("Android scenarios: "+report,report.getBoolean("ok"));
            assertEquals("All seven scenarios must execute",7,report.getJSONArray("checks").length());
        }
    }
}
