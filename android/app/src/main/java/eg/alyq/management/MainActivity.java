package eg.alyq.management;

import android.content.Context;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.BridgeActivity;

/**
 * ALYQ POS Android Activity.
 *
 * Exposes a narrow receipt-only print bridge (`window.ALYQAndroidPrint`) that
 * hands static receipt HTML to Android's system PrintManager (`com.android.printspooler`)
 * because `window.print()` inside an embedded Android WebView is otherwise a no-op.
 * The temporary print WebView runs with JavaScript disabled.
 */
public class MainActivity extends BridgeActivity {
    private WebView activePrintWebView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(new ALYQAndroidPrintBridge(), "ALYQAndroidPrint");
        }
    }

    public final class ALYQAndroidPrintBridge {
        @JavascriptInterface
        public boolean isSupported() {
            return getSystemService(Context.PRINT_SERVICE) != null;
        }

        @JavascriptInterface
        public boolean printHtml(final String html, final String reference) {
            if (html == null || html.trim().isEmpty() || html.length() > 256000) {
                return false;
            }
            final PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
            if (printManager == null) {
                return false;
            }
            runOnUiThread(() -> {
                try {
                    final WebView printWebView = new WebView(MainActivity.this);
                    printWebView.getSettings().setJavaScriptEnabled(false);
                    printWebView.getSettings().setLoadsImagesAutomatically(true);
                    activePrintWebView = printWebView;
                    final String safeRef = (reference != null && !reference.trim().isEmpty())
                        ? reference.replaceAll("[^A-Za-z0-9._-]", "_")
                        : "Receipt";
                    final String jobName = "ALYQ-POS-" + safeRef;

                    printWebView.setWebViewClient(new WebViewClient() {
                        private boolean dispatched = false;

                        @Override
                        public void onPageFinished(WebView view, String url) {
                            if (dispatched) return;
                            dispatched = true;
                            try {
                                PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(jobName);
                                PrintAttributes attributes = new PrintAttributes.Builder()
                                    .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                    .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                                    .build();
                                printManager.print(jobName, adapter, attributes);
                            } catch (Exception ignored) {
                                // Handled by Android PrintSpooler UI if unavailable
                            }
                        }
                    });
                    String sanitizedHtml = html.replace("onload=\"window.focus();window.print();\"", "");
                    printWebView.loadDataWithBaseURL("https://localhost/", sanitizedHtml, "text/html", "UTF-8", null);
                } catch (Exception ignored) {
                    // Fail safely without crashing the activity
                }
            });
            return true;
        }
    }
}
