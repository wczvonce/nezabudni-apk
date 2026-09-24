package sk.povraznik.ekasaskener;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.button.MaterialButton;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.common.HybridBinarizer;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanIntentResult;
import com.journeyapps.barcodescanner.ScanOptions;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.NumberFormat;
import java.time.DateTimeException;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * eKasa Skener BETA 0.2.0
 *
 * Standalone Android beta. QR decoding runs on the phone. The app sends only the
 * validated receipt identifier (or offline lookup tuple) to the fixed eKasa
 * "Over doklad" endpoint. The interface is unofficial and not guaranteed.
 */
public class MainActivity extends AppCompatActivity {

    private static final String ENDPOINT =
            "https://ekasa.financnasprava.sk/mdu/api/v1/opd/receipt/find";
    private static final String OFFICIAL_URL = "https://opd.financnasprava.sk/";
    private static final String PREFS = "ekasa_beta_prefs";
    private static final String HISTORY_KEY = "history_v1";
    private static final int MAX_HISTORY = 30;
    private static final int MAX_RESPONSE_CHARS = 2_000_000;

    private static final Pattern ONLINE_PATTERN = Pattern.compile(
            "(?i)([OV]-[0-9A-F]{32})(?![0-9A-F])");
    private static final Pattern OKP_PATTERN = Pattern.compile(
            "(?i)^[0-9A-F]{8}(?:-[0-9A-F]{8}){4}$");

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private ActivityResultLauncher<ScanOptions> scanLauncher;
    private ActivityResultLauncher<String> imagePicker;
    private SharedPreferences prefs;
    private LinearLayout content;
    private AlertDialog loadingDialog;

    private boolean dark;
    private int colorBg;
    private int colorCard;
    private int colorText;
    private int colorMuted;
    private int colorBorder;
    private int colorPrimary;
    private int colorPrimaryText;
    private int colorSuccess;
    private int colorWarning;
    private int colorDanger;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        initColors();
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#0B1220"));
        window.setNavigationBarColor(Color.parseColor("#0B1220"));

        scanLauncher = registerForActivityResult(new ScanContract(), this::onScanResult);
        imagePicker = registerForActivityResult(
                new ActivityResultContracts.GetContent(),
                uri -> {
                    if (uri != null) decodeQrImage(uri);
                });

        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(colorBg);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);

        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(18), dp(18), dp(18), dp(32));
        content.setBackgroundColor(colorBg);
        scroll.addView(content, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));
        frame.addView(scroll, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(frame);

        buildHome();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        executor.shutdownNow();
        hideLoading();
    }

    private void initColors() {
        dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        colorBg = Color.parseColor(dark ? "#080D18" : "#F5F7FB");
        colorCard = Color.parseColor(dark ? "#111827" : "#FFFFFF");
        colorText = Color.parseColor(dark ? "#F8FAFC" : "#111827");
        colorMuted = Color.parseColor(dark ? "#94A3B8" : "#64748B");
        colorBorder = Color.parseColor(dark ? "#273449" : "#DCE3EC");
        colorPrimary = Color.parseColor("#111827");
        colorPrimaryText = Color.WHITE;
        colorSuccess = Color.parseColor("#059669");
        colorWarning = Color.parseColor(dark ? "#FBBF24" : "#B45309");
        colorDanger = Color.parseColor("#DC2626");
    }

    private void buildHome() {
        content.removeAllViews();

        LinearLayout header = horizontal();
        header.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout titles = vertical();
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        titles.addView(text("eKasa Skener", 27, true));
        TextView version = text("v0.2.0-beta · Slovensko", 12, false);
        version.setTextColor(colorMuted);
        titles.addView(version);
        header.addView(titles, titleLp);

        MaterialButton history = smallButton("História (" + historyCount() + ")");
        history.setOnClickListener(v -> showHistory());
        header.addView(history);
        add(header, 0, 0, 0, 18);

        LinearLayout chips = horizontal();
        chips.addView(chip("Kamera", true), marginEnd(dp(8)));
        chips.addView(chip(isOnline() ? "Online" : "Offline", isOnline()));
        add(chips, 0, 0, 0, 16);

        MaterialButton scan = actionButton(
                "Naskenovať bloček\nOtvoriť zadnú kameru", true);
        scan.setOnClickListener(v -> startScanner());
        add(scan, 0, 0, 0, 10);

        MaterialButton photo = actionButton(
                "Nahrať fotku QR\nVybrať fotografiu alebo screenshot", false);
        photo.setOnClickListener(v -> imagePicker.launch("image/*"));
        add(photo, 0, 0, 0, 10);

        MaterialButton manual = actionButton(
                "Zadať ručne\nID dokladu alebo offline reťazec", false);
        manual.setOnClickListener(v -> showManualEntry());
        add(manual, 0, 0, 0, 10);

        MaterialButton demo = actionButton(
                "Spustiť ukážku\nZobraziť demo bloček bez internetu", false);
        demo.setOnClickListener(v -> showDemo());
        add(demo, 0, 0, 0, 20);

        LinearLayout info = card();
        TextView infoTitle = text("Ako to funguje", 15, true);
        info.addView(infoTitle);
        TextView infoBody = text(
                "Aplikácia načíta QR v telefóne a na overenie odošle iba ID dokladu " +
                        "alebo údaje offline dokladu. História zostáva iba v tomto telefóne.",
                13, false);
        infoBody.setTextColor(colorMuted);
        infoBody.setPadding(0, dp(7), 0, 0);
        info.addView(infoBody);
        add(info, 0, 0, 0, 12);

        LinearLayout warning = cardWithTint(
                dark ? Color.parseColor("#352812") : Color.parseColor("#FFF7E6"),
                dark ? Color.parseColor("#7C5A14") : Color.parseColor("#F3C675"));
        TextView warningTitle = text("Upozornenie – BETA", 14, true);
        warningTitle.setTextColor(colorWarning);
        warning.addView(warningTitle);
        TextView warningBody = text(
                "Beta používa negarantované rozhranie služby Over doklad Finančnej správy SR. " +
                        "Nie je určená na hromadné sťahovanie dokladov.",
                12, false);
        warningBody.setTextColor(colorWarning);
        warningBody.setPadding(0, dp(6), 0, 0);
        warning.addView(warningBody);
        add(warning, 0, 0, 0, 12);

        MaterialButton official = smallButton("Otvoriť oficiálnu službu Over doklad");
        official.setOnClickListener(v -> openOfficialSite());
        add(official, 0, 0, 0, 0);
    }

    private void startScanner() {
        ScanOptions options = new ScanOptions();
        options.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
        options.setPrompt("Namierte kameru na QR kód bločka");
        options.setBeepEnabled(false);
        options.setBarcodeImageEnabled(false);
        options.setOrientationLocked(false);
        scanLauncher.launch(options);
    }

    private void onScanResult(ScanIntentResult result) {
        if (result == null || result.getContents() == null) return;
        handleQrText(result.getContents());
    }

    private void showManualEntry() {
        EditText input = new EditText(this);
        input.setTextColor(colorText);
        input.setHintTextColor(colorMuted);
        input.setHint("O-AC6D... alebo celý offline QR reťazec");
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        input.setMinLines(3);
        input.setMaxLines(8);
        input.setPadding(dp(14), dp(12), dp(14), dp(12));
        input.setBackground(roundRect(colorCard, colorBorder, 14));

        FrameLayout box = new FrameLayout(this);
        box.setPadding(dp(22), dp(4), dp(22), 0);
        box.addView(input, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Zadať QR alebo ID ručne")
                .setView(box)
                .setNegativeButton("Zrušiť", null)
                .setPositiveButton("Overiť", null)
                .create();
        dialog.setOnShowListener(x -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(v -> {
                    String value = input.getText() == null ? "" : input.getText().toString();
                    if (value.trim().isEmpty()) {
                        input.setError("Zadajte obsah QR alebo ID dokladu.");
                        return;
                    }
                    dialog.dismiss();
                    handleQrText(value);
                }));
        dialog.show();
    }

    private void decodeQrImage(Uri uri) {
        showLoading("Hľadám QR kód na fotografii…");
        executor.execute(() -> {
            Bitmap bitmap = null;
            try {
                bitmap = decodeSampledBitmap(uri, 1800);
                if (bitmap == null) throw new IOException("Obrázok sa nedá načítať.");
                int width = bitmap.getWidth();
                int height = bitmap.getHeight();
                int[] pixels = new int[width * height];
                bitmap.getPixels(pixels, 0, width, 0, 0, width, height);
                RGBLuminanceSource source = new RGBLuminanceSource(width, height, pixels);
                BinaryBitmap binary = new BinaryBitmap(new HybridBinarizer(source));
                MultiFormatReader reader = new MultiFormatReader();
                Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
                hints.put(DecodeHintType.POSSIBLE_FORMATS,
                        Collections.singletonList(BarcodeFormat.QR_CODE));
                hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
                Result result = reader.decode(binary, hints);
                String value = result.getText();
                runOnUiThread(() -> {
                    hideLoading();
                    handleQrText(value);
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    hideLoading();
                    showMessage("QR sa nenašiel",
                            "Na fotografii sa nepodarilo rozpoznať QR kód. Skúste ostrejšiu fotku alebo kamerový skener.");
                });
            } finally {
                if (bitmap != null) bitmap.recycle();
            }
        });
    }

    private Bitmap decodeSampledBitmap(Uri uri, int maxSide) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            BitmapFactory.decodeStream(in, null, bounds);
        }
        int sample = 1;
        while (Math.max(bounds.outWidth / sample, bounds.outHeight / sample) > maxSide) {
            sample *= 2;
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = Math.max(1, sample);
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            return BitmapFactory.decodeStream(in, null, options);
        }
    }

    private void handleQrText(String raw) {
        ParsedQr parsed = parseQr(raw);
        if (parsed == null) {
            showMessage("Nepodporovaný QR kód",
                    "Toto nie je podporovaný slovenský eKasa bloček.");
            return;
        }

        if (!isOnline()) {
            JSONObject fallback = parsed.toFallbackReceipt();
            saveHistory(parsed.key(), fallback, false, false);
            displayReceipt(fallback, false, false,
                    "Telefón je offline. QR bol načítaný, ale doklad sa nepodarilo overiť.",
                    parsed.key());
            return;
        }

        showLoading("Overujem bloček v systéme eKasa…");
        executor.execute(() -> {
            ApiResult result = callEkasa(parsed);
            runOnUiThread(() -> {
                hideLoading();
                if (result.ok && result.receipt != null) {
                    saveHistory(parsed.key(), result.receipt, true, false);
                    displayReceipt(result.receipt, true, false, null, parsed.key());
                } else {
                    JSONObject fallback = parsed.toFallbackReceipt();
                    saveHistory(parsed.key(), fallback, false, false);
                    displayReceipt(fallback, false, false,
                            result.error == null
                                    ? "QR bol načítaný, online detail sa však nepodarilo získať."
                                    : result.error,
                            parsed.key());
                }
            });
        });
    }

    private ParsedQr parseQr(String rawInput) {
        if (rawInput == null) return null;
        String raw = rawInput.trim();
        if (raw.isEmpty()) return null;

        Matcher online = ONLINE_PATTERN.matcher(raw);
        if (online.find()) {
            ParsedQr parsed = new ParsedQr();
            parsed.online = true;
            parsed.receiptId = online.group(1).toUpperCase(Locale.ROOT);
            return parsed;
        }

        String[] parts = raw.split(":", -1);
        if (parts.length != 5) return null;
        String okp = parts[0].trim().toUpperCase(Locale.ROOT);
        String cashRegisterCode = parts[1].trim();
        String dateRaw = parts[2].trim();
        String receiptRaw = parts[3].trim();
        String amountRaw = parts[4].trim().replace(',', '.');

        if (!OKP_PATTERN.matcher(okp).matches()) return null;
        if (cashRegisterCode.isEmpty() || cashRegisterCode.length() > 64) return null;
        if (!dateRaw.matches("\\d{12}")) return null;
        if (!receiptRaw.matches("\\d+")) return null;
        if (!amountRaw.matches("\\d+(?:\\.\\d+)?")) return null;

        try {
            int year = 2000 + Integer.parseInt(dateRaw.substring(0, 2));
            int month = Integer.parseInt(dateRaw.substring(2, 4));
            int day = Integer.parseInt(dateRaw.substring(4, 6));
            int hour = Integer.parseInt(dateRaw.substring(6, 8));
            int minute = Integer.parseInt(dateRaw.substring(8, 10));
            int second = Integer.parseInt(dateRaw.substring(10, 12));
            LocalDateTime date = LocalDateTime.of(year, month, day, hour, minute, second);
            long receiptNumber = Long.parseLong(receiptRaw);
            if (receiptNumber < 0 || receiptNumber > Integer.MAX_VALUE) return null;
            BigDecimal amount = new BigDecimal(amountRaw);
            if (amount.signum() < 0 || amount.scale() > 6) return null;

            ParsedQr parsed = new ParsedQr();
            parsed.online = false;
            parsed.okp = okp;
            parsed.cashRegisterCode = cashRegisterCode;
            parsed.issueDateFormatted = date.format(
                    DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm:ss", Locale.ROOT));
            parsed.receiptNumber = (int) receiptNumber;
            parsed.totalAmount = amount.doubleValue();
            if (!Double.isFinite(parsed.totalAmount)) return null;
            return parsed;
        } catch (NumberFormatException | DateTimeException e) {
            return null;
        }
    }

    private ApiResult callEkasa(ParsedQr parsed) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(ENDPOINT);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(15_000);
            connection.setDoOutput(true);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json, text/plain, */*");
            connection.setRequestProperty("Content-Type", "application/json;charset=UTF-8");
            connection.setRequestProperty("Cache-Control", "no-cache");
            connection.setRequestProperty("User-Agent", "eKasa-Skener-BETA-Android/0.2.0");

            byte[] body = parsed.toRequestJson().toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body);
            }

            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 400
                    ? connection.getInputStream()
                    : connection.getErrorStream();
            String response = readResponse(stream);
            if (status < 200 || status >= 300) {
                return ApiResult.error("Služba Over doklad vrátila chybu HTTP " + status + ".");
            }
            if (response.trim().startsWith("<")) {
                return ApiResult.error(
                        "Služba Over doklad je momentálne blokovaná alebo nedostupná.");
            }

            JSONObject root = new JSONObject(response);
            String errorDescription = optCleanString(root, "errorDescription");
            Object errorCode = root.opt("errorCode");
            Object returnValue = root.has("returnValue")
                    ? root.opt("returnValue")
                    : root.opt("returnCode");

            JSONObject receipt = root.optJSONObject("receipt");
            if (receipt == null) {
                JSONObject nested = root.optJSONObject("result");
                if (nested != null) receipt = nested.optJSONObject("receipt");
            }

            boolean success = receipt != null
                    && isSuccessfulReturnValue(returnValue)
                    && isNoErrorCode(errorCode);
            if (!success) {
                return ApiResult.error(
                        errorDescription == null || errorDescription.isEmpty()
                                ? "Bloček sa nepodarilo overiť v systéme eKasa."
                                : errorDescription);
            }

            Object sanitized = sanitizeJson(receipt);
            if (!(sanitized instanceof JSONObject)) {
                return ApiResult.error("Odpoveď neobsahuje čitateľný doklad.");
            }
            return ApiResult.success((JSONObject) sanitized);
        } catch (java.net.SocketTimeoutException e) {
            return ApiResult.error("Časový limit vypršal. Skúste overenie zopakovať.");
        } catch (Exception e) {
            return ApiResult.error("Nepodarilo sa spojiť so službou Over doklad.");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String readResponse(InputStream stream) throws IOException {
        if (stream == null) return "";
        StringBuilder out = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            char[] buffer = new char[8192];
            int n;
            while ((n = reader.read(buffer)) >= 0) {
                if (out.length() + n > MAX_RESPONSE_CHARS) {
                    throw new IOException("Odpoveď je príliš veľká.");
                }
                out.append(buffer, 0, n);
            }
        }
        return out.toString();
    }

    private boolean isSuccessfulReturnValue(Object value) {
        if (value == null || value == JSONObject.NULL) return true;
        if (value instanceof Boolean) return (Boolean) value;
        if (value instanceof Number) {
            int n = ((Number) value).intValue();
            return n == 0 || n == 1;
        }
        String s = String.valueOf(value).trim();
        return s.isEmpty() || s.equals("0") || s.equalsIgnoreCase("OK")
                || s.equalsIgnoreCase("true") || s.equals("1");
    }

    private boolean isNoErrorCode(Object value) {
        if (value == null || value == JSONObject.NULL) return true;
        if (value instanceof Number) return ((Number) value).intValue() == 0;
        String s = String.valueOf(value).trim();
        return s.isEmpty() || s.equals("0") || s.equalsIgnoreCase("null");
    }

    private Object sanitizeJson(Object value) throws JSONException {
        if (value == null || value == JSONObject.NULL) return JSONObject.NULL;
        if (value instanceof JSONArray) {
            JSONArray source = (JSONArray) value;
            JSONArray target = new JSONArray();
            for (int i = 0; i < source.length(); i++) {
                target.put(sanitizeJson(source.opt(i)));
            }
            return target;
        }
        if (value instanceof JSONObject) {
            JSONObject source = (JSONObject) value;
            JSONObject target = new JSONObject();
            Iterator<String> keys = source.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (key.toLowerCase(Locale.ROOT).contains("pkp")) continue;
                target.put(key, sanitizeJson(source.opt(key)));
            }
            return target;
        }
        return value;
    }

    private void displayReceipt(
            JSONObject receipt,
            boolean verified,
            boolean demo,
            String warning,
            String historyId) {
        content.removeAllViews();

        LinearLayout top = horizontal();
        top.setGravity(Gravity.CENTER_VERTICAL);
        MaterialButton back = smallButton("← Späť");
        back.setOnClickListener(v -> buildHome());
        top.addView(back);
        TextView title = text("Detail bločku", 18, true);
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        title.setGravity(Gravity.END);
        top.addView(title, titleLp);
        add(top, 0, 0, 0, 14);

        TextView badge = text(
                demo ? "DEMO" : verified ? "OVERENÝ DOKLAD" : "NAČÍTANÝ – NEOVERENÝ",
                12,
                true);
        badge.setTextColor(demo ? colorWarning : verified ? colorSuccess : colorWarning);
        badge.setGravity(Gravity.CENTER);
        badge.setPadding(dp(12), dp(10), dp(12), dp(10));
        badge.setBackground(roundRect(
                demo
                        ? (dark ? Color.parseColor("#34280F") : Color.parseColor("#FFF5D8"))
                        : verified
                        ? (dark ? Color.parseColor("#0B3025") : Color.parseColor("#E6F7F1"))
                        : (dark ? Color.parseColor("#34280F") : Color.parseColor("#FFF5D8")),
                demo || !verified
                        ? (dark ? Color.parseColor("#806119") : Color.parseColor("#E8C36A"))
                        : (dark ? Color.parseColor("#176B50") : Color.parseColor("#7FD3B5")),
                12));
        add(badge, 0, 0, 0, 12);

        if (warning != null && !warning.isEmpty()) {
            LinearLayout warningCard = cardWithTint(
                    dark ? Color.parseColor("#352812") : Color.parseColor("#FFF7E6"),
                    dark ? Color.parseColor("#7C5A14") : Color.parseColor("#F3C675"));
            TextView w = text(warning, 13, false);
            w.setTextColor(colorWarning);
            warningCard.addView(w);
            add(warningCard, 0, 0, 0, 12);
        }

        Double total = findNumber(receipt,
                "totalPrice", "totalAmount", "total", "amount", "priceTotal");
        String issueDate = findString(receipt,
                "issueDate", "issueDateFormatted", "createDate", "timestamp", "date");

        LinearLayout totalCard = card();
        TextView totalLabel = text("Celková suma", 12, true);
        totalLabel.setTextColor(colorMuted);
        totalCard.addView(totalLabel);
        TextView totalValue = text(formatMoney(total), 34, true);
        totalValue.setPadding(0, dp(3), 0, 0);
        totalCard.addView(totalValue);
        if (issueDate != null) {
            TextView date = text(issueDate, 13, false);
            date.setTextColor(colorMuted);
            date.setPadding(0, dp(8), 0, 0);
            totalCard.addView(date);
        }
        add(totalCard, 0, 0, 0, 12);

        String seller = findString(receipt,
                "organizationName", "companyName", "businessName", "tradeName", "sellerName");
        if (seller == null) seller = findString(receipt, "name");
        String ico = findString(receipt, "ico", "companyId", "identificationNumber");
        String dic = findString(receipt, "dic", "taxId");
        String icDph = findString(receipt, "icDph", "vatId", "vatNumber");
        String address = findAddress(receipt);

        LinearLayout sellerCard = card();
        sellerCard.addView(sectionTitle("Predajca"));
        TextView sellerName = text(seller == null ? (ico == null ? "—" : "IČO " + ico) : seller,
                17, true);
        sellerName.setPadding(0, dp(7), 0, 0);
        sellerCard.addView(sellerName);
        if (address != null) {
            TextView addressView = text(address, 13, false);
            addressView.setTextColor(colorMuted);
            addressView.setPadding(0, dp(5), 0, dp(6));
            sellerCard.addView(addressView);
        }
        addKeyValue(sellerCard, "IČO", ico);
        addKeyValue(sellerCard, "DIČ", dic);
        addKeyValue(sellerCard, "IČ DPH", icDph);
        add(sellerCard, 0, 0, 0, 12);

        JSONArray items = findArray(receipt, "items", "receiptItems", "positions");
        LinearLayout itemCard = card();
        itemCard.addView(sectionTitle(
                items == null ? "Položky" : "Položky (" + items.length() + ")"));
        if (items == null || items.length() == 0) {
            TextView none = text("Údaje o položkách nie sú dostupné.", 13, false);
            none.setTextColor(colorMuted);
            none.setPadding(0, dp(7), 0, 0);
            itemCard.addView(none);
        } else {
            int limit = Math.min(items.length(), 250);
            for (int i = 0; i < limit; i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) continue;
                if (i > 0) itemCard.addView(divider());
                renderItem(itemCard, item);
            }
            if (items.length() > limit) {
                TextView truncated = text("Ďalšie položky neboli zobrazené.", 12, false);
                truncated.setTextColor(colorMuted);
                truncated.setPadding(0, dp(8), 0, 0);
                itemCard.addView(truncated);
            }
        }
        add(itemCard, 0, 0, 0, 12);

        LinearLayout vatCard = createVatCard(receipt);
        if (vatCard != null) add(vatCard, 0, 0, 0, 12);

        String receiptId = findString(receipt, "receiptId", "id", "uuid");
        String receiptNumber = findString(receipt, "receiptNumber", "number", "invoiceNumber");
        String receiptType = findString(receipt, "receiptType", "type", "documentType");
        String register = findString(receipt, "cashRegisterCode", "ecrCode", "eKasaCode");
        String okp = findString(receipt, "okp", "OKP");

        LinearLayout idCard = card();
        idCard.addView(sectionTitle("Identifikácia"));
        addKeyValue(idCard, "ID dokladu", receiptId);
        addKeyValue(idCard, "Číslo dokladu", receiptNumber);
        addKeyValue(idCard, "Typ dokladu", receiptType);
        addKeyValue(idCard, "Kód pokladnice", register);
        addKeyValue(idCard, "OKP", okp);
        add(idCard, 0, 0, 0, 12);

        MaterialButton official = actionButton(
                "Overiť na oficiálnom webe\nopd.financnasprava.sk", false);
        official.setOnClickListener(v -> openOfficialSite());
        add(official, 0, 0, 0, 10);

        MaterialButton next = actionButton("Naskenovať ďalší bloček", true);
        next.setOnClickListener(v -> startScanner());
        add(next, 0, 0, 0, 10);

        if (historyId != null) {
            MaterialButton delete = smallButton("Vymazať tento doklad z histórie");
            delete.setTextColor(colorDanger);
            delete.setOnClickListener(v -> confirmDeleteHistory(historyId));
            add(delete, 0, 0, 0, 0);
        }
    }

    private void renderItem(LinearLayout parent, JSONObject item) {
        String name = directString(item, "name", "description", "itemName", "text");
        Double quantity = directNumber(item, "quantity", "qty");
        String unit = directString(item, "unit", "measurement", "measureUnit");
        Double unitPrice = directNumber(item, "unitPrice", "pricePerUnit", "priceUnit");
        Double totalPrice = directNumber(item,
                "totalPrice", "priceTotal", "sumPrice", "amount", "price");
        Double vatRate = directNumber(item, "vatRate", "taxRate", "vat");

        LinearLayout row = horizontal();
        row.setGravity(Gravity.TOP);
        LinearLayout left = vertical();
        LinearLayout.LayoutParams leftLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        TextView itemName = text(name == null ? "Položka" : name, 14, true);
        left.addView(itemName);
        List<String> meta = new ArrayList<>();
        if (quantity != null) {
            meta.add(trimNumber(quantity) + (unit == null || unit.isEmpty() ? "" : " " + unit));
        }
        if (unitPrice != null) meta.add("jedn. " + formatMoney(unitPrice));
        if (vatRate != null) meta.add("DPH " + trimNumber(vatRate) + "%");
        if (!meta.isEmpty()) {
            TextView metaView = text(join(meta, " · "), 12, false);
            metaView.setTextColor(colorMuted);
            metaView.setPadding(0, dp(3), 0, 0);
            left.addView(metaView);
        }
        row.addView(left, leftLp);
        TextView price = text(formatMoney(totalPrice), 14, true);
        price.setGravity(Gravity.END);
        price.setPadding(dp(12), 0, 0, 0);
        row.addView(price);
        row.setPadding(0, dp(10), 0, dp(10));
        parent.addView(row);
    }

    private LinearLayout createVatCard(JSONObject receipt) {
        JSONArray rows = findArray(receipt, "vatSummary", "taxSummary", "vatBreakdown");
        List<VatRow> vatRows = new ArrayList<>();
        if (rows != null) {
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.optJSONObject(i);
                if (row == null) continue;
                Double rate = directNumber(row, "rate", "vatRate", "taxRate");
                Double base = directNumber(row, "base", "taxBase", "vatBase");
                Double vat = directNumber(row, "vat", "vatAmount", "tax", "amount");
                if (rate != null || base != null || vat != null) {
                    vatRows.add(new VatRow(rate, base, vat));
                }
            }
        }
        addFlatVat(vatRows, receipt,
                "vatRateBasic", "taxBaseBasic", "vatAmountBasic", null);
        addFlatVat(vatRows, receipt,
                "vatRateReduced", "taxBaseReduced", "vatAmountReduced", null);
        addFlatVat(vatRows, receipt,
                "vatRateReduced2", "taxBaseReduced2", "vatAmountReduced2", null);
        addFlatVat(vatRows, receipt,
                "vatRateZero", "taxBaseZero", "vatAmountZero", 0d);

        if (vatRows.isEmpty()) return null;
        LinearLayout card = card();
        card.addView(sectionTitle("Súhrn DPH"));
        for (int i = 0; i < vatRows.size(); i++) {
            if (i > 0) card.addView(divider());
            VatRow row = vatRows.get(i);
            LinearLayout line = horizontal();
            line.setPadding(0, dp(8), 0, dp(8));
            TextView rate = text(
                    row.rate == null ? "Sadzba —" : "DPH " + trimNumber(row.rate) + "%",
                    13,
                    true);
            line.addView(rate, new LinearLayout.LayoutParams(
                    0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            TextView amounts = text(
                    "základ " + formatMoney(row.base) + " · DPH " + formatMoney(row.vat),
                    12,
                    false);
            amounts.setTextColor(colorMuted);
            amounts.setGravity(Gravity.END);
            line.addView(amounts);
            card.addView(line);
        }
        return card;
    }

    private void addFlatVat(
            List<VatRow> rows,
            JSONObject receipt,
            String rateKey,
            String baseKey,
            String vatKey,
            Double defaultRate) {
        Double rate = directNumber(receipt, rateKey);
        Double base = directNumber(receipt, baseKey);
        Double vat = directNumber(receipt, vatKey);
        if (rate == null) rate = defaultRate;
        if (rate != null || base != null || vat != null) rows.add(new VatRow(rate, base, vat));
    }

    private void showDemo() {
        try {
            JSONObject receipt = new JSONObject();
            receipt.put("receiptId", "DEMO-20260727-0001");
            receipt.put("organizationName", "DEMO Potraviny, s. r. o.");
            receipt.put("street", "Námestie 1");
            receipt.put("postalCode", "974 01");
            receipt.put("city", "Banská Bystrica");
            receipt.put("ico", "12345678");
            receipt.put("dic", "2020123456");
            receipt.put("icDph", "SK2020123456");
            receipt.put("issueDate", "27.07.2026 16:00:00");
            receipt.put("cashRegisterCode", "88812345678900001");
            receipt.put("receiptNumber", "42");
            receipt.put("receiptType", "Pokladničný doklad");
            receipt.put("totalPrice", 12.47);

            JSONArray items = new JSONArray();
            items.put(new JSONObject()
                    .put("name", "Chlieb celozrnný")
                    .put("quantity", 1)
                    .put("unit", "ks")
                    .put("unitPrice", 2.19)
                    .put("totalPrice", 2.19)
                    .put("vatRate", 19));
            items.put(new JSONObject()
                    .put("name", "Mlieko 1 l")
                    .put("quantity", 2)
                    .put("unit", "ks")
                    .put("unitPrice", 1.29)
                    .put("totalPrice", 2.58)
                    .put("vatRate", 19));
            items.put(new JSONObject()
                    .put("name", "Ovocie")
                    .put("quantity", 1.5)
                    .put("unit", "kg")
                    .put("unitPrice", 5.13)
                    .put("totalPrice", 7.70)
                    .put("vatRate", 5));
            receipt.put("items", items);

            JSONArray vat = new JSONArray();
            vat.put(new JSONObject().put("vatRate", 5).put("taxBase", 7.33).put("vatAmount", 0.37));
            vat.put(new JSONObject().put("vatRate", 19).put("taxBase", 4.01).put("vatAmount", 0.76));
            receipt.put("vatSummary", vat);

            String id = "DEMO-20260727-0001";
            saveHistory(id, receipt, false, true);
            displayReceipt(receipt, false, true, null, id);
        } catch (JSONException e) {
            Toast.makeText(this, "Demo sa nepodarilo vytvoriť.", Toast.LENGTH_SHORT).show();
        }
    }

    private void showHistory() {
        content.removeAllViews();
        LinearLayout header = horizontal();
        header.setGravity(Gravity.CENTER_VERTICAL);
        MaterialButton back = smallButton("← Späť");
        back.setOnClickListener(v -> buildHome());
        header.addView(back);
        TextView title = text("História", 23, true);
        title.setGravity(Gravity.END);
        header.addView(title, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        add(header, 0, 0, 0, 14);

        TextView privacy = text("História zostáva iba v tomto telefóne. Najviac 30 dokladov.",
                12, false);
        privacy.setTextColor(colorMuted);
        add(privacy, 0, 0, 0, 12);

        EditText search = new EditText(this);
        search.setSingleLine(true);
        search.setHint("Hľadať predajcu, ID alebo položku");
        search.setTextColor(colorText);
        search.setHintTextColor(colorMuted);
        search.setPadding(dp(14), dp(12), dp(14), dp(12));
        search.setBackground(roundRect(colorCard, colorBorder, 14));
        add(search, 0, 0, 0, 12);

        LinearLayout listContainer = vertical();
        renderHistoryList(listContainer, "");
        add(listContainer, 0, 0, 0, 14);

        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {
                renderHistoryList(listContainer, s == null ? "" : s.toString());
            }
            @Override public void afterTextChanged(Editable s) {}
        });

        if (historyCount() > 0) {
            MaterialButton clear = smallButton("Vymazať celú históriu");
            clear.setTextColor(colorDanger);
            clear.setOnClickListener(v -> new AlertDialog.Builder(this)
                    .setTitle("Vymazať históriu?")
                    .setMessage("Všetky lokálne uložené doklady sa odstránia.")
                    .setNegativeButton("Zrušiť", null)
                    .setPositiveButton("Vymazať", (d, w) -> {
                        prefs.edit().remove(HISTORY_KEY).apply();
                        showHistory();
                    })
                    .show());
            add(clear, 0, 0, 0, 0);
        }
    }

    private void renderHistoryList(LinearLayout container, String query) {
        container.removeAllViews();
        JSONArray history = loadHistory();
        String needle = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        int shown = 0;
        for (int i = 0; i < history.length(); i++) {
            JSONObject entry = history.optJSONObject(i);
            if (entry == null) continue;
            JSONObject receipt = entry.optJSONObject("receipt");
            if (receipt == null) continue;
            if (!needle.isEmpty()
                    && !receipt.toString().toLowerCase(Locale.ROOT).contains(needle)) continue;

            String id = entry.optString("id", "");
            boolean verified = entry.optBoolean("verified", false);
            boolean demo = entry.optBoolean("demo", false);
            LinearLayout row = horizontal();
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setBackground(roundRect(colorCard, colorBorder, 14));
            row.setPadding(dp(6), dp(6), dp(6), dp(6));

            String seller = findString(receipt,
                    "organizationName", "companyName", "businessName", "sellerName");
            if (seller == null) seller = findString(receipt, "receiptId", "okp");
            Double amount = findNumber(receipt, "totalPrice", "totalAmount", "total", "amount");
            String status = demo ? "DEMO" : verified ? "Overený" : "Neoverený";
            MaterialButton open = smallButton(
                    (seller == null ? "Doklad" : seller) + "\n" + formatMoney(amount) + " · " + status);
            open.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
            open.setOnClickListener(v -> displayReceipt(receipt, verified, demo, null, id));
            row.addView(open, new LinearLayout.LayoutParams(
                    0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            MaterialButton remove = smallButton("✕");
            remove.setMinWidth(dp(48));
            remove.setTextColor(colorDanger);
            remove.setOnClickListener(v -> {
                deleteHistory(id);
                renderHistoryList(container, query);
            });
            row.addView(remove, new LinearLayout.LayoutParams(
                    dp(54), ViewGroup.LayoutParams.WRAP_CONTENT));

            LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT);
            rowLp.bottomMargin = dp(9);
            container.addView(row, rowLp);
            shown++;
        }
        if (shown == 0) {
            TextView empty = text(
                    history.length() == 0 ? "Zatiaľ tu nie sú žiadne doklady." : "Nenašiel sa žiadny doklad.",
                    14,
                    false);
            empty.setGravity(Gravity.CENTER);
            empty.setTextColor(colorMuted);
            empty.setPadding(dp(10), dp(30), dp(10), dp(30));
            container.addView(empty);
        }
    }

    private void saveHistory(
            String id,
            JSONObject receipt,
            boolean verified,
            boolean demo) {
        try {
            JSONArray old = loadHistory();
            JSONArray fresh = new JSONArray();
            JSONObject entry = new JSONObject();
            entry.put("id", id == null || id.isEmpty() ? String.valueOf(System.currentTimeMillis()) : id);
            entry.put("savedAt", System.currentTimeMillis());
            entry.put("verified", verified);
            entry.put("demo", demo);
            entry.put("receipt", sanitizeJson(receipt));
            fresh.put(entry);
            for (int i = 0; i < old.length() && fresh.length() < MAX_HISTORY; i++) {
                JSONObject previous = old.optJSONObject(i);
                if (previous == null) continue;
                if (entry.optString("id").equals(previous.optString("id"))) continue;
                fresh.put(previous);
            }
            prefs.edit().putString(HISTORY_KEY, fresh.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    private JSONArray loadHistory() {
        String raw = prefs.getString(HISTORY_KEY, "[]");
        try {
            return new JSONArray(raw == null ? "[]" : raw);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private int historyCount() {
        return loadHistory().length();
    }

    private void deleteHistory(String id) {
        JSONArray old = loadHistory();
        JSONArray fresh = new JSONArray();
        for (int i = 0; i < old.length(); i++) {
            JSONObject entry = old.optJSONObject(i);
            if (entry == null) continue;
            if (id != null && id.equals(entry.optString("id"))) continue;
            fresh.put(entry);
        }
        prefs.edit().putString(HISTORY_KEY, fresh.toString()).apply();
    }

    private void confirmDeleteHistory(String id) {
        new AlertDialog.Builder(this)
                .setTitle("Vymazať doklad?")
                .setMessage("Doklad sa odstráni iba z lokálnej histórie v tomto telefóne.")
                .setNegativeButton("Zrušiť", null)
                .setPositiveButton("Vymazať", (dialog, which) -> {
                    deleteHistory(id);
                    buildHome();
                })
                .show();
    }

    private boolean isOnline() {
        try {
            ConnectivityManager cm =
                    (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            Network network = cm.getActiveNetwork();
            if (network == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(network);
            return caps != null
                    && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Exception e) {
            return true;
        }
    }

    private String findAddress(JSONObject receipt) {
        Object direct = findValue(receipt, Set.of("address", "fulladdress"), 3);
        if (direct instanceof String && !((String) direct).trim().isEmpty()) {
            return ((String) direct).trim();
        }
        if (direct instanceof JSONObject) {
            JSONObject addressObject = (JSONObject) direct;
            String formatted = directString(addressObject, "formatted", "fullAddress", "address");
            if (formatted != null) return formatted;
        }
        List<String> parts = new ArrayList<>();
        String street = findString(receipt, "street", "addressStreet");
        String number = findString(receipt, "buildingNumber", "houseNumber");
        String postal = findString(receipt, "postalCode", "zip");
        String city = findString(receipt, "city", "municipality");
        if (street != null) parts.add(street + (number == null ? "" : " " + number));
        if (postal != null || city != null) {
            parts.add((postal == null ? "" : postal + " ") + (city == null ? "" : city));
        }
        String value = join(parts, ", ").trim();
        return value.isEmpty() ? null : value;
    }

    private String findString(JSONObject object, String... names) {
        Object value = findValue(object, lowerSet(names), 4);
        if (value == null || value == JSONObject.NULL || value instanceof JSONObject
                || value instanceof JSONArray) return null;
        String text = String.valueOf(value).trim();
        return text.isEmpty() ? null : text;
    }

    private Double findNumber(JSONObject object, String... names) {
        Object value = findValue(object, lowerSet(names), 4);
        return asDouble(value);
    }

    private JSONArray findArray(JSONObject object, String... names) {
        Object value = findValue(object, lowerSet(names), 4);
        return value instanceof JSONArray ? (JSONArray) value : null;
    }

    private Object findValue(Object node, Set<String> names, int depth) {
        if (node == null || node == JSONObject.NULL || depth < 0) return null;
        if (node instanceof JSONObject) {
            JSONObject object = (JSONObject) node;
            Iterator<String> keys = object.keys();
            List<String> allKeys = new ArrayList<>();
            while (keys.hasNext()) allKeys.add(keys.next());
            for (String key : allKeys) {
                if (names.contains(key.toLowerCase(Locale.ROOT))) {
                    Object value = object.opt(key);
                    if (value != null && value != JSONObject.NULL && !String.valueOf(value).isEmpty()) {
                        return value;
                    }
                }
            }
            for (String key : allKeys) {
                Object child = object.opt(key);
                if (child instanceof JSONObject) {
                    Object found = findValue(child, names, depth - 1);
                    if (found != null) return found;
                }
            }
        }
        return null;
    }

    private Set<String> lowerSet(String... names) {
        java.util.HashSet<String> set = new java.util.HashSet<>();
        for (String name : names) set.add(name.toLowerCase(Locale.ROOT));
        return set;
    }

    private String directString(JSONObject object, String... keys) {
        for (String key : keys) {
            Object value = optCaseInsensitive(object, key);
            if (value == null || value == JSONObject.NULL || value instanceof JSONObject
                    || value instanceof JSONArray) continue;
            String text = String.valueOf(value).trim();
            if (!text.isEmpty()) return text;
        }
        return null;
    }

    private Double directNumber(JSONObject object, String... keys) {
        for (String key : keys) {
            Double value = asDouble(optCaseInsensitive(object, key));
            if (value != null) return value;
        }
        return null;
    }

    private Object optCaseInsensitive(JSONObject object, String target) {
        if (object.has(target)) return object.opt(target);
        Iterator<String> keys = object.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (key.equalsIgnoreCase(target)) return object.opt(key);
        }
        return null;
    }

    private Double asDouble(Object value) {
        if (value == null || value == JSONObject.NULL) return null;
        try {
            double n = value instanceof Number
                    ? ((Number) value).doubleValue()
                    : Double.parseDouble(String.valueOf(value).trim().replace(',', '.'));
            return Double.isFinite(n) ? n : null;
        } catch (Exception e) {
            return null;
        }
    }

    private String optCleanString(JSONObject object, String key) {
        Object value = object.opt(key);
        if (value == null || value == JSONObject.NULL) return null;
        String s = String.valueOf(value).trim();
        return s.isEmpty() || s.equalsIgnoreCase("null") ? null : s;
    }

    private void openOfficialSite() {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(OFFICIAL_URL)));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, OFFICIAL_URL, Toast.LENGTH_LONG).show();
        }
    }

    private void showLoading(String message) {
        hideLoading();
        LinearLayout box = horizontal();
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(dp(22), dp(20), dp(22), dp(20));
        ProgressBar progress = new ProgressBar(this);
        box.addView(progress, new LinearLayout.LayoutParams(dp(34), dp(34)));
        TextView label = text(message, 14, true);
        label.setPadding(dp(16), 0, 0, 0);
        box.addView(label, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        loadingDialog = new AlertDialog.Builder(this)
                .setView(box)
                .setCancelable(false)
                .create();
        loadingDialog.show();
    }

    private void hideLoading() {
        if (loadingDialog != null) {
            try {
                loadingDialog.dismiss();
            } catch (Exception ignored) {
            }
            loadingDialog = null;
        }
    }

    private void showMessage(String title, String message) {
        new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(message)
                .setNegativeButton("Zavrieť", null)
                .setPositiveButton("Oficiálny web", (dialog, which) -> openOfficialSite())
                .show();
    }

    private LinearLayout card() {
        LinearLayout card = vertical();
        card.setPadding(dp(16), dp(15), dp(16), dp(15));
        card.setBackground(roundRect(colorCard, colorBorder, 16));
        return card;
    }

    private LinearLayout cardWithTint(int fill, int stroke) {
        LinearLayout card = vertical();
        card.setPadding(dp(16), dp(15), dp(16), dp(15));
        card.setBackground(roundRect(fill, stroke, 16));
        return card;
    }

    private LinearLayout horizontal() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.HORIZONTAL);
        return layout;
    }

    private LinearLayout vertical() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private MaterialButton actionButton(String label, boolean primary) {
        MaterialButton button = new MaterialButton(this);
        button.setText(label);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        button.setAllCaps(false);
        button.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        button.setTextAlignment(View.TEXT_ALIGNMENT_TEXT_START);
        button.setMinHeight(dp(72));
        button.setPadding(dp(18), dp(12), dp(18), dp(12));
        button.setCornerRadius(dp(16));
        button.setInsetTop(0);
        button.setInsetBottom(0);
        button.setStrokeWidth(primary ? 0 : dp(1));
        button.setStrokeColor(ColorStateList.valueOf(colorBorder));
        button.setBackgroundTintList(ColorStateList.valueOf(primary ? colorPrimary : colorCard));
        button.setTextColor(primary ? colorPrimaryText : colorText);
        return button;
    }

    private MaterialButton smallButton(String label) {
        MaterialButton button = new MaterialButton(this);
        button.setText(label);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        button.setAllCaps(false);
        button.setCornerRadius(dp(13));
        button.setInsetTop(0);
        button.setInsetBottom(0);
        button.setStrokeWidth(dp(1));
        button.setStrokeColor(ColorStateList.valueOf(colorBorder));
        button.setBackgroundTintList(ColorStateList.valueOf(colorCard));
        button.setTextColor(colorText);
        return button;
    }

    private TextView chip(String label, boolean ok) {
        TextView chip = text(label, 11, true);
        chip.setTextColor(ok ? colorSuccess : colorMuted);
        chip.setPadding(dp(10), dp(6), dp(10), dp(6));
        chip.setBackground(roundRect(
                ok
                        ? (dark ? Color.parseColor("#0B3025") : Color.parseColor("#E7F8F1"))
                        : colorCard,
                ok
                        ? (dark ? Color.parseColor("#176B50") : Color.parseColor("#8ADBBE"))
                        : colorBorder,
                30));
        return chip;
    }

    private TextView sectionTitle(String value) {
        TextView title = text(value, 14, true);
        title.setTextColor(colorMuted);
        return title;
    }

    private void addKeyValue(LinearLayout parent, String key, String value) {
        if (value == null || value.trim().isEmpty()) return;
        LinearLayout row = horizontal();
        row.setGravity(Gravity.TOP);
        row.setPadding(0, dp(7), 0, 0);
        TextView keyView = text(key, 12, false);
        keyView.setTextColor(colorMuted);
        row.addView(keyView, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView valueView = text(value, 12, true);
        valueView.setGravity(Gravity.END);
        valueView.setTextIsSelectable(true);
        row.addView(valueView, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.55f));
        parent.addView(row);
    }

    private TextView text(String value, int sp, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(colorText);
        view.setLineSpacing(0, 1.08f);
        if (bold) view.setTypeface(view.getTypeface(), android.graphics.Typeface.BOLD);
        return view;
    }

    private View divider() {
        View line = new View(this);
        line.setBackgroundColor(colorBorder);
        line.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));
        return line;
    }

    private GradientDrawable roundRect(int fill, int stroke, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radiusDp));
        drawable.setStroke(dp(1), stroke);
        return drawable;
    }

    private void add(View view, int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(left), dp(top), dp(right), dp(bottom));
        content.addView(view, lp);
    }

    private LinearLayout.LayoutParams marginEnd(int px) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = px;
        return lp;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private String formatMoney(Double amount) {
        if (amount == null || !Double.isFinite(amount)) return "—";
        NumberFormat format = NumberFormat.getCurrencyInstance(new Locale("sk", "SK"));
        format.setCurrency(java.util.Currency.getInstance("EUR"));
        return format.format(amount);
    }

    private String trimNumber(Double value) {
        if (value == null) return "—";
        if (Math.rint(value) == value) return String.valueOf(value.longValue());
        return BigDecimal.valueOf(value).stripTrailingZeros().toPlainString();
    }

    private String join(List<String> values, String delimiter) {
        StringBuilder out = new StringBuilder();
        for (String value : values) {
            if (value == null || value.isEmpty()) continue;
            if (out.length() > 0) out.append(delimiter);
            out.append(value);
        }
        return out.toString();
    }

    private static final class ParsedQr {
        boolean online;
        String receiptId;
        String okp;
        String cashRegisterCode;
        String issueDateFormatted;
        int receiptNumber;
        double totalAmount;

        JSONObject toRequestJson() throws JSONException {
            JSONObject json = new JSONObject();
            if (online) {
                json.put("receiptId", receiptId);
            } else {
                json.put("okp", okp);
                json.put("cashRegisterCode", cashRegisterCode);
                json.put("issueDateFormatted", issueDateFormatted);
                json.put("receiptNumber", receiptNumber);
                json.put("totalAmount", totalAmount);
            }
            return json;
        }

        JSONObject toFallbackReceipt() {
            JSONObject json = new JSONObject();
            try {
                if (online) {
                    json.put("receiptId", receiptId);
                } else {
                    json.put("okp", okp);
                    json.put("cashRegisterCode", cashRegisterCode);
                    json.put("issueDate", issueDateFormatted);
                    json.put("receiptNumber", receiptNumber);
                    json.put("totalAmount", totalAmount);
                }
            } catch (JSONException ignored) {
            }
            return json;
        }

        String key() {
            return online
                    ? receiptId
                    : okp + "|" + cashRegisterCode + "|" + receiptNumber;
        }
    }

    private static final class ApiResult {
        final boolean ok;
        final JSONObject receipt;
        final String error;

        private ApiResult(boolean ok, JSONObject receipt, String error) {
            this.ok = ok;
            this.receipt = receipt;
            this.error = error;
        }

        static ApiResult success(JSONObject receipt) {
            return new ApiResult(true, receipt, null);
        }

        static ApiResult error(String error) {
            return new ApiResult(false, null, error);
        }
    }

    private static final class VatRow {
        final Double rate;
        final Double base;
        final Double vat;

        VatRow(Double rate, Double base, Double vat) {
            this.rate = rate;
            this.base = base;
            this.vat = vat;
        }
    }
}
