# Support Playbook — eBay Multi-Channel Lister Pro

This document contains 20 copy-paste scripted responses for the top support tickets and merchant queries.

---

## 📋 Scripted Responses Registry (20 Items)

### 1. eBay Developer Account Pending Approval
> **Merchant Query**: *"My eBay client credentials are not working; it says pending in the developer console."*
> **Response**:
> *"Hi there, eBay Developer accounts usually require manual verification from eBay's developer support team, which can take 1–3 business days. Please ensure you have completed the registration profile and requested keys for both sandbox and production environments. Once verified, copy the App ID and Cert ID into your local `.env` file."*

### 2. Shopify Private App Access Token Error
> **Merchant Query**: *"I get an unauthorized error when syncing my Shopify store."*
> **Response**:
> *"Hi! This is usually caused by incorrect scope permissions on your Shopify Custom App. Go to Shopify Admin > Settings > Apps and Sales Channels > Develop Apps. Select your app and verify that 'Admin API integration' has read/write scopes enabled for Products, Inventory, and Locations. Re-generate the access token and update your `.env` file."*

### 3. GDI+ Native Image Sizing Failure
> **Merchant Query**: *"The watcher logs show GDI+ script error when I drop a photo."*
> **Response**:
> *"Hi! Lister Pro uses native Windows GDI+ scripts via PowerShell to square and watermark images without external packages. This error indicates PowerShell script execution policy restrictions on your machine. Open PowerShell as Administrator and run: `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine` then restart the server."*

### 4. Stripe Webhook Signature Verification Fail
> **Merchant Query**: *"Why does my local server log Stripe webhook 400 signature errors?"*
> **Response**:
> *"Hi there, in development mode, you must forward Stripe webhooks using the Stripe CLI (`stripe listen --forward-to localhost:45900/api/billing/webhook`). The CLI will output a webhook signing secret starting with `whsec_`. Copy this exact key into your `.env` file as `STRIPE_WEBHOOK_SECRET` to verify signatures."*

### 5. Double-Selling Prevention Sync Interval
> **Merchant Query**: *"How fast does the double-selling protection end active items?"*
> **Response**:
> *"Hi! Lister Pro's background synchronization runs every 5 minutes by default. When an item sells on eBay, it will be marked as ended on Shopify and Etsy during the next sync run. You can trigger an immediate manual synchronization at any time by clicking the 'Sync Now' button in the dashboard header."*

### 6. Etsy API Key Scope Access Error
> **Merchant Query**: *"Etsy cross-posts fail with scope errors."*
> **Response**:
> *"Hi! Etsy OAuth tokens expire and require the 'listings_w' write scope during authentication. Ensure your Etsy developer token is currently active and that you authorized Lister Pro to manage active listings. Click 'Re-authenticate Etsy' in the settings panel to refresh."*

### 7. WooCommerce Consumer Key / Secret Mismatch
> **Merchant Query**: *"WooCommerce sync returns 401 Unauthorized."*
> **Response**:
> *"Hi! WooCommerce requires both Consumer Key (`ck_`) and Consumer Secret (`cs_`). Double-check that you copied both keys exactly without spaces into your `.env` file, and that your WooCommerce site has HTTPS enabled, as REST API key validation fails over HTTP."*

### 8. Outlier Comp Pricing returns 0
> **Merchant Query**: *"Pricing comp calculator shows $0.00 for my item."*
> **Response**:
> *"Hi! This happens when there are no active listings on eBay matching your title keywords, or when all active matches are filtered out as statistical outliers. Try editing your listing draft title to be more specific (e.g., adding model number or brand) and click 'Recalculate Comps'."*

### 9. Right to Erasure Account Deletion
> **Merchant Query**: *"How do I delete all my session data and credentials?"*
> **Response**:
> *"Hi there, Lister Pro is completely compliant with GDPR/CCPA. You can instantly wipe all local credentials, active session cookies, and inventory history by going to Settings > Security > Click 'Permanently Delete Account' (or firing `DELETE /api/user/account`). This wipes all local database JSON entries in-place."*

### 10. Rate Limit 429 Block
> **Merchant Query**: *"I got blocked with a Too Many Requests message."*
> **Response**:
> *"Hi! To protect your local database from spam and coordinate API usage, Lister Pro runs a native rate limiter. If you trigger multiple rapid uploads, you may be temporarily throttled. Wait 60 seconds and the window will reset."*

### 11. Changing Default Listing Shipping Option
> **Merchant Query**: *"How do I change the default shipping carrier?"*
> **Response**:
> *"Hi! You can set your preferred carrier in your `.env` file using the `DEFAULT_SHIPPING_OPTION` variable (e.g., `USPS_GROUND`, `UPS_GROUND`, or `FEDEX_HOME`). Alternatively, you can change this per-item on the publish card before submitting."*

### 12. VeRO Brand Flag warning
> **Merchant Query**: *"Lister Pro shows an amber warning for my brand, what does it mean?"*
> **Response**:
> *"Hi! Lister Pro matched the brand in your title against our database of 400+ VeRO brand restrictions. This means the brand owner actively reports unauthorized sellers. We advise caution: check if you have retail invoices or authorization before publishing this item on eBay."*

### 13. Local-First Database Backup Location
> **Merchant Query**: *"Where are my inventory files backed up?"*
> **Response**:
> *"Hi! Lister Pro saves data in flat files inside the `/data` directory in your project root. Every time a write completes, a replica is stored as `.bak` (e.g., `history.json.bak`). You can copy this entire `/data` folder to back up your listings."*

### 14. File Lock Jam Error
> **Merchant Query**: *"Logs show Database file currently locked."*
> **Response**:
> *"Hi! This indicates another concurrent process is writing to the database. Our built-in queue handles reader/writer locking and will automatically retry the read/write in milliseconds. No action is required."*

### 15. Barcode Scanner is not extracting UPC
> **Merchant Query**: *"Gemini Vision is not finding my barcode from the photo."*
> **Response**:
> *"Hi! Ensure the barcode is clearly visible, well-lit, and in focus. If the image is blurry, the AI will fail to extract the numbers. You can manually enter the 12-digit UPC code in the aspect field if extraction fails."*

### 16. Port Conflict on Boot
> **Merchant Query**: *"The server fails to start, saying address already in use."*
> **Response**:
> *"Hi! This means another process is using port 45900. You can change the port by modifying `PORT` in your `.env` file, or running the server with: `PORT=45950 node start.js`."*

### 17. Multi-Channel Concurrent Publish Timeout
> **Merchant Query**: *"Publishing takes too long and fails."*
> **Response**:
> *"Hi! When publishing, Lister Pro calls eBay, Shopify, and Etsy concurrently. If one platform's API is slow, the request might take up to 30 seconds. The successful channels will commit, and the failed channel will be sent to the DLQ. You can check the upload status on the admin panel."*

### 18. Image Watermarking Overlay Color Customization
> **Merchant Query**: *"How do I change the watermark text color?"*
> **Response**:
> *"Hi! Watermarking is governed by the native Windows script. You can configure the text value using `WATERMARK_TEXT` in your `.env`. Currently, color values default to white with 50% transparency for maximum compatibility."*

### 19. Google OAuth Redirect Mismatch
> **Merchant Query**: *"OAuth redirect URL mismatch during Google login."*
> **Response**:
> *"Hi! Ensure the Google Client credentials in your `.env` are configured, and that the redirect URI is listed exactly in your Google Cloud Console > APIs & Services > Credentials > Authorized redirect URIs. It must match your live URL callback."*

### 20. Ending a Listing from the Dashboard
> **Merchant Query**: *"How do I end an eBay listing directly from the UI?"*
> **Response**:
> *"Hi! Go to the Active Inventory list, select your item, and click 'End Listing'. This will communicate with eBay's API to immediately withdraw the offer, update its status in your local database, and sync changes to Shopify."*
