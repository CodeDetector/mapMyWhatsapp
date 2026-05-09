# WhatsApp Cloud API Migration Guide

## Overview
This guide walks through migrating from **Baileys** (WhatsApp Web automation) to the **WhatsApp Cloud Official API** by Meta. The Cloud API is production-ready, officially supported, and doesn't require QR code scanning or device linking.

---

## Why Migrate to Cloud API?

| Feature | Baileys | Cloud API |
|---------|---------|-----------|
| **Official Support** | Unofficial, reverse-engineered | Officially supported by Meta |
| **Reliability** | Frequent breaking changes | Stable, guaranteed uptime |
| **Scalability** | Single device per account | Enterprise-grade scaling |
| **Authentication** | QR code + device linking | API tokens (token-based) |
| **Session Management** | Local file storage | No local sessions needed |
| **Rate Limiting** | WhatsApp Web limits | Configurable, documented limits |
| **Business Features** | Limited | Full business suite (templates, etc.) |
| **Cost** | Free | $0.005 per message (incoming free) |

---

## Pre-Migration Checklist

### 1. Meta Business Account Setup
- [ ] Create/access Meta Business Account at https://business.facebook.com
- [ ] Verify your business identity
- [ ] Create a WhatsApp Business App

### 2. Phone Number Registration
- [ ] Verify or register a dedicated phone number for business use
- [ ] Complete phone number verification in Meta Business Manager
- [ ] Generate API credentials

### 3. Get Required Credentials
From Meta Business Developer Console:
- [ ] **Access Token** - From Settings → API Credentials
- [ ] **Phone Number ID** - From Phone Numbers section
- [ ] **Business Account ID** - From Account Settings
- [ ] **App Secret** - For webhook signature verification

### 4. Set Up Webhook
- [ ] Ensure your server has a public URL (for receiving messages)
- [ ] SSL/TLS certificate must be valid
- [ ] HTTPS endpoint at `/webhook`

---

## Migration Steps

### Step 1: Install Dependencies
```bash
cd mapMyWhatsapp
npm install
```

The `package.json` has been updated to:
- ✅ Remove: `@whiskeysockets/baileys` and `qrcode-terminal`
- ✅ Add: `axios` (for HTTP requests to Cloud API)

### Step 2: Configure Environment Variables
Create `.env` file in `mapMyWhatsapp/`:

```env
# WhatsApp Cloud API
WHATSAPP_API_TYPE=cloud
WHATSAPP_ACCESS_TOKEN=your_access_token_here
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_BUSINESS_ACCOUNT_ID=your_business_account_id
WHATSAPP_APP_SECRET=your_app_secret_for_webhook_verification
WHATSAPP_WEBHOOK_VERIFY_TOKEN=your_custom_webhook_verify_token
WHATSAPP_WEBHOOK_URL=https://your-domain.com/webhook

# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_supabase_key

# Google Gemini AI Configuration
GEMINI_API_KEY=your_gemini_api_key

# Google OAuth (for Gmail)
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

# Optional Settings
ALLOWED_GROUPS=
ALLOW_PRIVATE_CHATS=false
PORT=3001
```

### Step 3: Configure Webhook in Meta Developer Console
1. Go to Meta App Dashboard
2. WhatsApp → Configuration
3. Webhook URL: `https://your-domain.com/webhook`
4. Verify Token: Use the same as `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
5. Subscribe to webhook events:
   - ✅ messages
   - ✅ message_template_status_update
   - ✅ message_template_quality_update

### Step 4: Verify Webhook
The system automatically handles webhook verification:
- GET requests with `hub.challenge` are verified against the token
- POST requests include signature validation

### Step 5: Update Database Schema (if needed)
If storing employee credentials per-user:

```sql
ALTER TABLE employees ADD COLUMN IF NOT EXISTS whatsapp_credentials JSONB;

-- Example structure:
-- {
--   "access_token": "EAABs...",
--   "phone_number_id": "1234567890",
--   "business_account_id": "1234567890"
-- }
```

### Step 6: Remove Baileys Session Storage
```bash
# Old Baileys sessions can be safely deleted
rm -rf ./auth_info_baileys/
rm -rf ./mapMyWhatsapp/sessions/  # If using new structure

# These are no longer needed with Cloud API
```

### Step 7: Start the Service
```bash
# Development
node mapMyWhatsapp/index.js

# Docker
docker-compose up omni-whatsapp

# Check logs
docker logs omni-whatsapp -f
```

---

## File Structure Changes

### New Files Added
```
mapMyWhatsapp/
├── whatsappCloudService.js      # Cloud API client wrapper
├── webhookHandler.js             # Webhook event receiver
├── processorCloudAPI.js         # Main processor (replaces Baileys processor)
├── .env.example                  # Configuration template
└── index.js                      # (Updated) Entry point
```

### Modified Files
```
mapMyWhatsapp/
├── processor.js                  # ⚠️ DEPRECATED - Use processorCloudAPI.js
├── config.js                     # ✅ Updated with Cloud API vars
├── package.json                  # ✅ Updated dependencies
├── generateReport.js             # ✅ Updated for Cloud API compatibility
└── index.js                      # ✅ Updated to use Cloud API

wa-field-tracker-ui/
└── src/components/onboarding/
    └── WhatsAppOnboarding.jsx    # ✅ Updated UI for token-based auth

wa-field-tracker/
└── docker-compose.yml            # ✅ Updated for Cloud API
```

---

## API Architecture

### Cloud API Message Types Supported
- ✅ **Text** - Simple text messages
- ✅ **Image** - Photos with optional captions
- ✅ **Document** - PDFs and other files
- ✅ **Video** - Videos with captions
- ✅ **Audio** - Audio messages
- ✅ **Location** - Geographic coordinates
- ✅ **Interactive** - Buttons and lists
- ✅ **Template** - Pre-approved message templates

### Webhook Events
```javascript
// Incoming Message
POST /webhook
{
  "entry": [{
    "changes": [{
      "value": {
        "messages": [{
          "from": "918239200149",
          "id": "wamid.xxx",
          "timestamp": "1234567890",
          "type": "text",
          "text": { "body": "Hello" }
        }],
        "contacts": [{
          "profile": { "name": "John Doe" },
          "wa_id": "918239200149"
        }]
      }
    }]
  }]
}
```

---

## Testing the Migration

### 1. Local Testing
```bash
# Start the service
node mapMyWhatsapp/index.js

# Should output:
# 📡 WhatsApp Cloud API Manager listening on port 3001
# 📧 Webhook endpoint: POST http://localhost:3001/webhook
# 🔐 Webhook verification endpoint: GET http://localhost:3001/webhook

# Test sending message
curl -X POST http://localhost:3001/api/test/send-message \
  -H "Content-Type: application/json" \
  -d '{
    "employeeId": "default",
    "recipientPhone": "918239200149",
    "message": "Test from Cloud API"
  }'
```

### 2. Webhook Verification
Test webhook setup in Meta Developer Console:
- Click "Test Webhook" button
- Should return 200 OK with challenge response
- Check logs: "✅ Webhook verified successfully"

### 3. Send a Test Message
```bash
# From WhatsApp
# Send message to your business phone number
# Should appear in your database and backend logs
```

### 4. Full Integration Test
1. Send message to business number
2. Check database for incoming message
3. Verify media download (if sending image)
4. Check AI screening results
5. Verify knowledge graph processing

---

## Troubleshooting

### Issue: "Failed to verify webhook signature"
**Solution**: 
- Verify `WHATSAPP_APP_SECRET` is correct
- Ensure request headers include `x-hub-signature-256`
- Check Meta console for webhook signature validation

### Issue: "Missing WhatsApp credentials"
**Solution**:
- Check `.env` file has all required variables
- Verify `WHATSAPP_ACCESS_TOKEN` hasn't expired
- Regenerate token in Meta Developer Console if needed

### Issue: "Messages not being received"
**Solution**:
- Verify webhook URL is publicly accessible (HTTPS)
- Check webhook subscription in Meta console includes "messages"
- Review logs: `docker logs omni-whatsapp -f`
- Test webhook manually in Meta dashboard

### Issue: "Cannot send message to recipient"
**Solution**:
- Verify phone number format includes country code (e.g., 918239200149)
- Check phone number is opted-in for messages
- Verify recipient hasn't blocked the business account
- Check message template compliance if using templates

---

## Known Differences from Baileys

### Session Management
| Baileys | Cloud API |
|---------|-----------|
| QR code scanning | Token-based auth |
| Device-specific sessions | Account-level tokens |
| Session stored locally | No local storage needed |
| Can receive via phone | Centralized endpoints |

### Message Reception
| Baileys | Cloud API |
|---------|-----------|
| Socket events | Webhook callbacks |
| Real-time (via polling) | Event-driven (webhooks) |
| Device state tracking | Simple connected/disconnected |

### Message Sending
| Baileys | Cloud API |
|---------|-----------|
| `sock.sendMessage(jid, msg)` | `service.sendTextMessage(phone, text)` |
| Uses WhatsApp Web | Uses official Graph API |
| No rate limits enforced | Rate limited by Meta |

---

## Performance & Scale

### Limits & Quotas
- **Message Rate**: Up to 1,000 messages per second per business account
- **Media Size**: Max 100MB per media file
- **Concurrent Connections**: Unlimited (no session per device)
- **Daily Budget**: Configurable in Meta console

### Cost Estimation
- **Incoming Messages**: Free
- **Outgoing Messages**: $0.005 per message (average)
- **Template Messages**: $0.001 per message (first 1K free/month)
- **Free Tier**: First 1,000 messages/month free

Example for 10,000 outgoing messages/month:
```
(10,000 - 1,000) × $0.005 = $45/month
```

---

## Rollback Plan

If you need to revert to Baileys:
1. Keep old `processor.js` and Baileys code in git history
2. Revert `package.json` to include Baileys
3. Update `index.js` to use old processor
4. Restore Baileys sessions from backup

However, **we strongly recommend staying on Cloud API** due to:
- ✅ Official support
- ✅ Better reliability
- ✅ Future-proof architecture
- ✅ Better compliance & security

---

## Next Steps

1. ✅ Set up Meta Business Account
2. ✅ Configure webhook in Meta console
3. ✅ Deploy to production
4. ✅ Monitor logs for errors
5. ✅ Test critical workflows
6. ✅ Inform team about changes

---

## Support & Resources

- **Meta WhatsApp API Docs**: https://developers.facebook.com/docs/whatsapp
- **Webhook Reference**: https://developers.facebook.com/docs/whatsapp/webhooks
- **API Rate Limits**: https://developers.facebook.com/docs/graph-api/rate-limiting
- **Message Templates**: https://developers.facebook.com/docs/whatsapp/message-templates

---

## Summary of Changes

| Component | Change | Status |
|-----------|--------|--------|
| Backend Service | Baileys → Cloud API | ✅ Complete |
| Session Management | Local files → Token-based | ✅ Complete |
| Message Receiving | Socket events → Webhooks | ✅ Complete |
| Message Sending | WhatsApp Web → Graph API | ✅ Complete |
| UI Authentication | QR code → Token input | ✅ Complete |
| Docker Setup | Updated paths & env vars | ✅ Complete |
| Dependencies | Removed Baileys, added axios | ✅ Complete |
| Documentation | Migration guide created | ✅ Complete |

**Status**: Ready for deployment! 🚀
