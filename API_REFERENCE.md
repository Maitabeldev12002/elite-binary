# Elite Binary - API Reference

## Base URL
```
http://localhost:3000/api
```

## Authentication
Include JWT token in Authorization header:
```
Authorization: Bearer <token>
```

---

## Authentication Endpoints

### POST /auth/register
Create a new account.

**Request:**
```json
{
  "identifier": "user@example.com",
  "name": "John Doe",
  "password": "SecurePassword123",
  "demo": false
}
```

**Response:**
```json
{
  "user": {
    "id": "usr_abc123",
    "identifier": "user@example.com",
    "name": "John Doe",
    "balance": 0,
    "demo": false,
    "verified": false,
    "createdAt": "2026-05-07T12:34:56Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

---

### POST /auth/login
Login to existing account.

**Request:**
```json
{
  "identifier": "user@example.com",
  "password": "SecurePassword123"
}
```

**Response:**
```json
{
  "user": { /* user object */ },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

---

### POST /auth/request-otp
Request a One-Time Password.

**Request:**
```json
{
  "identifier": "user@example.com"
}
```

**Response:**
```json
{
  "ok": true,
  "expiresAt": "2026-05-07T12:44:56Z",
  "devOtp": "123456" // Only in development
}
```

---

### POST /auth/verify-otp
Verify OTP code.

**Request:**
```json
{
  "identifier": "user@example.com",
  "otp": "123456"
}
```

**Response:**
```json
{
  "ok": true,
  "verified": true
}
```

---

### POST /auth/reset-password
Reset password with OTP.

**Request:**
```json
{
  "identifier": "user@example.com",
  "otp": "123456",
  "newPassword": "NewPassword123"
}
```

**Response:**
```json
{
  "ok": true,
  "user": { /* user object */ },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

---

## User Endpoints

### GET /user/profile
Get current user profile (requires auth).

**Response:**
```json
{
  "user": {
    "id": "usr_abc123",
    "identifier": "user@example.com",
    "name": "John Doe",
    "balance": 10000,
    "demo": true,
    "verified": true,
    "role": "user",
    "createdAt": "2026-05-07T12:34:56Z"
  }
}
```

---

### GET /wallet
Get wallet and transaction history (requires auth).

**Response:**
```json
{
  "user": { /* user object */ },
  "ledger": [
    {
      "id": "led_abc123",
      "userId": "usr_abc123",
      "type": "deposit",
      "amount": 1000,
      "balanceAfter": 11000,
      "reference": "dep_abc123",
      "createdAt": "2026-05-07T12:34:56Z"
    }
  ]
}
```

---

### GET /config
Get platform configuration.

**Response:**
```json
{
  "config": {
    "settlementMode": "fair_server",
    "payoutRate": 0.9,
    "winProbability": 0.5,
    "settlementDelayMs": 900,
    "designatedWallet": "im"
    "mockPayments": true
  }
}
```

---

## Trading Endpoints

### POST /trades
Execute a trade (requires auth).

**Request:**
```json
{
  "contractType": "DIGITEVEN",
  "symbol": "1HZ10V",
  "stake": 100,
  "params": {
    "barrier": 5
  }
}
```

**Response:**
```json
{
  "trade": {
    "id": "trd_abc123",
    "userId": "usr_abc123",
    "contractType": "DIGITEVEN",
    "symbol": "1HZ10V",
    "stake": 100,
    "won": true,
    "profit": 90,
    "balanceAfter": 10090,
    "outcome": {
      "won": true,
      "probability": 0.5,
      "payout": 0.9
    },
    "createdAt": "2026-05-07T12:34:56Z"
  },
  "user": { /* updated user object */ },
  "config": { /* config object */ }
}
```

---

### GET /trades
Get trade history (requires auth).

**Query Parameters:**
- `limit` (optional, default 100): Max trades to return

**Response:**
```json
{
  "trades": [
    {
      "id": "trd_abc123",
      "userId": "usr_abc123",
      "contractType": "DIGITEVEN",
      "stake": 100,
      "won": true,
      "profit": 90,
      "createdAt": "2026-05-07T12:34:56Z"
    }
  ]
}
```

---

## Payment Endpoints

### POST /deposits
Initiate a deposit (requires auth).

**Request:**
```json
{
  "method": "mpesa",
  "phone": "254712345678",
  "amount": 1000
}
```

**Response:**
```json
{
  "deposit": {
    "id": "dep_abc123",
    "userId": "usr_abc123",
    "method": "mpesa",
    "phone": "254712345678",
    "amount": 1000,
    "status": "completed",
    "createdAt": "2026-05-07T12:34:56Z"
  },
  "user": { /* updated user object */ }
}
```

---

### POST /mpesa/stk-callback
M-Pesa STK push callback (webhook).

**Request:**
```json
{
  "Body": {
    "stkCallback": {
      "MerchantRequestID": "xxx",
      "CheckoutRequestID": "ws_co_123",
      "ResultCode": 0,
      "ResultDesc": "The service request has been processed successfully."
    }
  }
}
```

---

### POST /payhero/callback
PayHero STK push callback (webhook).

**Request:**
```json
{
  "response": {
    "Amount": 10,
    "CheckoutRequestID": "ws_CO_14012024103543427709099876",
    "ExternalReference": "dep_abc123",
    "MpesaReceiptNumber": "SAE3YULR0Y",
    "Phone": "+254709099876",
    "ResultCode": 0,
    "Status": "Success"
  },
  "status": true
}
```

---

### POST /withdrawals
Initiate a withdrawal (requires auth).

**Request:**
```json
{
  "method": "mpesa",
  "destination": "254712345678",
  "amount": 500
}
```

**Response:**
```json
{
  "withdrawal": {
    "id": "wd_abc123",
    "userId": "usr_abc123",
    "method": "mpesa",
    "destination": "254712345678",
    "amount": 500,
    "status": "processing",
    "createdAt": "2026-05-07T12:34:56Z"
  },
  "user": { /* updated user object */ }
}
```

---

### POST /mpesa/b2c-result
M-Pesa B2C payment result callback (webhook).

**Request:**
```json
{
  "Result": {
    "ResultType": 0,
    "ResultCode": 0,
    "ResultDesc": "The service request has been processed successfully.",
    "OriginatorConversationID": "wd_abc123",
    "ConversationID": "AN41A8QD60",
    "TransactionID": "LHG31AA60C"
  }
}
```

---

## Admin Endpoints

### GET /admin/summary
Get admin dashboard (requires X-Admin-Key header).

**Headers:**
```
X-Admin-Key: your-admin-key
```

**Response:**
```json
{
  "config": { /* config object */ },
  "users": [ /* array of users */ ],
  "deposits": [ /* recent deposits */ ],
  "withdrawals": [ /* recent withdrawals */ ],
  "trades": [ /* recent trades */ ],
  "ledger": [ /* recent ledger entries */ ]
}
```

---

### POST /admin/config
Update platform configuration (requires X-Admin-Key header).

**Request:**
```json
{
  "payoutRate": 0.95,
  "winProbability": 0.55,
  "mockPayments": false
}
```

**Response:**
```json
{
  "config": { /* updated config */ }
}
```

---

### POST /admin/users/suspend
Suspend a user account (requires X-Admin-Key header).

**Request:**
```json
{
  "userId": "usr_abc123",
  "suspended": true
}
```

**Response:**
```json
{
  "user": { /* updated user */ }
}
```

---

### POST /admin/withdrawals/approve
Approve or reject a withdrawal (requires X-Admin-Key header).

**Request:**
```json
{
  "withdrawalId": "wd_abc123",
  "action": "approve" // or "reject"
}
```

**Response:**
```json
{
  "withdrawal": { /* updated withdrawal */ }
}
```

---

### POST /admin/deposits/approve
Approve a deposit (requires X-Admin-Key header).

**Request:**
```json
{
  "depositId": "dep_abc123"
}
```

**Response:**
```json
{
  "deposit": { /* updated deposit */ }
}
```

---

## Health Check

### GET /health
Check API status.

**Response:**
```json
{
  "ok": true,
  "time": "2026-05-07T12:34:56Z"
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Descriptive error message"
}
```

### HTTP Status Codes
- `200` - Success
- `400` - Bad request (validation error)
- `401` - Unauthorized (missing/invalid auth)
- `403` - Forbidden (insufficient permissions)
- `404` - Not found
- `409` - Conflict (e.g., account already exists)
- `500` - Server error

---

## Examples

### Register Demo Account
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "identifier": "demo@example.com",
    "name": "Demo User",
    "demo": true
  }'
```

### Login and Get Profile
```bash
# 1. Login
TOKEN=$(curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"identifier":"demo@example.com","password":""}' | jq -r '.token')

# 2. Get Profile
curl -X GET http://localhost:3000/api/user/profile \
  -H "Authorization: Bearer $TOKEN"
```

### Execute a Trade
```bash
curl -X POST http://localhost:3000/api/trades \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "contractType": "DIGITEVEN",
    "stake": 100
  }'
```

---

## Rate Limiting
Currently no rate limiting. Consider implementing for production.

## API Versioning
Current version: `v1` (via `/api` prefix)

Future versions can use `/api/v2`, etc.

---

**Last Updated:** 2026-05-07
**API Version:** 1.0.0
